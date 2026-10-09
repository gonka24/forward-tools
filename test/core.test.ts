/** Synthetic fixtures only. No network, Docker, or live chain calls. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DirectSecp256k1Wallet } from "@cosmjs/proto-signing";
import { toBech32 } from "@cosmjs/encoding";
import { TxRaw, SignDoc } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { Chain, hash } from "../src/chain.js";
import {
  decimal,
  economics,
  ToolError,
  Deployment,
  Operation,
} from "../src/model.js";
import { ROUTE, CLAIM, encodeNative, decodeNative } from "../src/native.js";
import { prepare, revalidate } from "../src/operations.js";
import {
  wire,
  verifySigned,
  txJson,
  confirm,
  broadcast,
  exportTx,
  checkFresh,
} from "../src/transactions.js";
const A = toBech32("gonka", new Uint8Array(20).fill(1)),
  B = toBech32("gonka", new Uint8Array(20).fill(2)),
  D = toBech32("gonka", new Uint8Array(32).fill(3));
const deployment: Deployment = {
  id: "synthetic",
  chainId: "synthetic-chain",
  nodes: ["http://synthetic.invalid"],
  gonkaSha: "a".repeat(40),
  contractsSha: "b".repeat(40),
  factory: D,
  factoryCodeId: 1,
  dealCodeId: 2,
  token: D,
  feeRecipient: A,
  factoryHash: "c".repeat(64),
  dealHash: "d".repeat(64),
  tokenHash: "e".repeat(64),
  feeBps: 150,
  protoSha: "f".repeat(40),
  evidence: "synthetic",
};
function fixture(state = "open", current = 9) {
  const k = {
    factory: D,
    host: A,
    deal_address: D,
    target_epoch: 10,
    price_micro_usdt_per_gnk: "1000000",
    buyer_budget_micro_usdt: "100000000",
    settlement_cw20: D,
    fee_recipient: A,
    fee_bps: 150,
    pinned_gonka_sha: deployment.protoSha,
  };
  const s = {
    status: state,
    buyer: state === "open" ? null : B,
    recipient_locked: state === "locked",
    released_total_ngonka: "0",
  };
  const c = new Chain(deployment);
  let routes = [
      { epoch: "10", recipient: D },
      { epoch: "11", recipient: B },
    ],
    claimed = false;
  c.verify = async () => ({
    status: "VERIFIED",
    deployment: "synthetic",
    observations: [],
  });
  c.tip = async () => "100";
  c.currentEpoch = async () => current;
  c.host = async () => ({ index: A });
  c.deal = async () => ({
    config: k,
    state: s,
    payments: {
      host: { pending_micro_usdt: "1" },
      fee: { pending_micro_usdt: "0" },
      buyer: { pending_micro_usdt: "2" },
    },
  });
  c.routes = async () => routes;
  c.summary = async () => ({ claimed });
  c.balance = async () => "100";
  c.smart = async () => ({ balance: "100000000" });
  return {
    c,
    k,
    s,
    setRoutes: (v: typeof routes) => (routes = v),
    setClaimed: (v: boolean) => (claimed = v),
  };
}
test("decimal micro amounts and fee arithmetic preserve conservation without floating point", () => {
  assert.equal(decimal("0.000001"), "1");
  assert.equal(decimal("1.25"), "1250000");
  const e = economics("100000000", "1000000", "80000000000");
  assert.equal(e.feeMicroUsdt, "1200000");
  assert.equal(
    BigInt(e.hostNetMicroUsdt) +
      BigInt(e.feeMicroUsdt) +
      BigInt(e.buyerRefundMicroUsdt),
    100000000n,
  );
  for (const v of ["1e6", "-1", "1.0000001", "NaN", "01", ""])
    assert.throws(() => decimal(v));
  assert.throws(() => economics("1", "999999999999999999999"));
});
test("native protobuf bytes match independently specified golden wire fields", () => {
  const r = { creator: "x", entries: [{ epoch: "42", recipient: "y" }] };
  assert.equal(
    Buffer.from(encodeNative(ROUTE, r)).toString("hex"),
    "0a01781205082a120179",
  );
  assert.deepEqual(decodeNative(ROUTE, encodeNative(ROUTE, r)), r);
  const q = { creator: "x", seed: "7", epoch_index: "42" };
  assert.equal(
    Buffer.from(encodeNative(CLAIM, q)).toString("hex"),
    "0a01781007182a",
  );
  assert.deepEqual(decodeNative(CLAIM, encodeNative(CLAIM, q)), q);
});
test("native protobuf omits proto3 default fields exactly as the Gonka CLI", () => {
  assert.equal(
    Buffer.from(
      encodeNative(ROUTE, {
        creator: "x",
        entries: [{ epoch: "42", recipient: "" }],
      }),
    ).toString("hex"),
    "0a01781202082a",
  );
  assert.equal(
    Buffer.from(
      encodeNative(CLAIM, { creator: "x", seed: "0", epoch_index: "42" }),
    ).toString("hex"),
    "0a0178182a",
  );
});
for (const action of ["route", "remove-route"] as const)
  test(`${action} changes only target epoch and retains snapshot of other routes`, async () => {
    const { c } = fixture();
    const op = await prepare(c, action, A, { deal: D });
    assert.equal(op.messages[0].value.entries.length, 1);
    assert.equal(op.terms.previousRoutes.length, 2);
    assert.equal(
      op.messages[0].value.entries[0].recipient,
      action === "route" ? D : "",
    );
    await assert.rejects(prepare(c, action, B, { deal: D }), /owner/);
  });
test("funding uses authenticated CW20 Send exact budget and Fund hook", async () => {
  const { c } = fixture();
  const op = await prepare(c, "fund", B, { deal: D });
  assert.deepEqual(op.messages[0].value.msg, {
    send: { contract: D, amount: "100000000", msg: "eyJmdW5kIjp7fX0=" },
  });
});
test("funding rejects ignored amount overrides rather than silently signing immutable budget", async () => {
  const { c } = fixture();
  await assert.rejects(
    prepare(c, "fund", B, { deal: D, budget: "1" }),
    /Unexpected fields/,
  );
});
test("refund does not interpret string false as explicit emergency authorization", async () => {
  const { c } = fixture("locked", 13);
  await assert.rejects(
    prepare(c, "refund", B, { deal: D, emergency: "false" }),
    /explicit boolean/,
  );
});
for (const [action, state, current, extra] of [
  ["lock", "funded", 10, {}],
  ["claim", "locked", 11, { seed: "7" }],
  ["settle", "locked", 11, {}],
  ["withdraw", "completed", 15, { role: "host" }],
  ["release", "completed", 15, {}],
  ["forward-excess", "completed", 15, {}],
  ["cancel", "open", 9, {}],
  ["refund", "locked", 12, {}],
] as const)
  test(`${action} can be prepared in valid state`, async () => {
    const { c, setRoutes, setClaimed } = fixture(state, current);
    if (action === "settle") setClaimed(true);
    if (action === "cancel") setRoutes([]);
    const op = await prepare(
      c,
      action,
      ["claim", "cancel"].includes(action) ? A : B,
      { deal: D, ...extra },
    );
    assert.equal(op.messages.length, 1);
  });
for (const [action, state, current, extra] of [
  ["fund", "open", 10, {}],
  ["lock", "funded", 15, {}],
  ["lock", "locked", 10, {}],
  ["claim", "locked", 12, { seed: "7" }],
  ["settle", "funded", 11, {}],
  ["withdraw", "completed", 15, { role: "fee" }],
  ["release", "open", 15, {}],
  ["forward-excess", "releasing", 15, {}],
  ["cancel", "funded", 9, {}],
  ["refund", "locked", 11, {}],
] as const)
  test(`${action} rejects invalid ${state} at epoch ${current}`, async () => {
    const { c } = fixture(state, current);
    await assert.rejects(prepare(c, action, A, { deal: D, ...extra }));
  });
test("routing query failure never becomes missing routing", async () => {
  const { c } = fixture("funded", 10);
  c.routes = async () => {
    throw new ToolError("RPC_ERROR", "synthetic outage");
  };
  await assert.rejects(prepare(c, "refund", A, { deal: D }), /outage/);
});
test("claimed summary blocks refund and query failure needs explicit emergency review", async () => {
  const { c, setClaimed } = fixture("locked", 13);
  setClaimed(true);
  await assert.rejects(
    prepare(c, "refund", A, { deal: D, emergency: true }),
    /confirmed/,
  );
  c.summary = async () => {
    throw new ToolError("RPC_ERROR", "synthetic");
  };
  await assert.rejects(prepare(c, "refund", A, { deal: D }), /review/);
  assert.equal(
    (await prepare(c, "refund", A, { deal: D, emergency: true })).terms
      .emergencyReview,
    true,
  );
});
test("revalidation rejects operation message substitution", async () => {
  const { c } = fixture();
  const op = await prepare(c, "fund", B, { deal: D });
  op.messages[0].value.msg.send.amount = "1";
  await assert.rejects(revalidate(c, op), /changed/);
});
test("revalidation rejects altered displayed immutable commercial terms", async () => {
  const { c } = fixture();
  const op = await prepare(c, "fund", B, { deal: D });
  op.terms.price_micro_usdt_per_gnk = "1";
  await assert.rejects(revalidate(c, op), /Displayed immutable terms/);
});
test("example packages cannot authorize a live transaction even with valid shape", async () => {
  const { c } = fixture();
  const op = await prepare(c, "fund", B, { deal: D });
  op.test_fixture_only = true;
  await assert.rejects(revalidate(c, op), /Example\/test/);
});
test("signature binds messages fee chain account sender and sequence", async () => {
  const wallet = await DirectSecp256k1Wallet.fromKey(
      new Uint8Array(32).fill(7),
      "gonka",
    ),
    [a] = await wallet.getAccounts();
  const op: Operation = {
    schema: "gonka24/forward-operation/1",
    deployment,
    sender: a.address,
    action: "lock",
    input: { deal: D },
    messages: [
      {
        typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
        value: { sender: a.address, contract: D, msg: { lock: {} }, funds: [] },
      },
    ],
    terms: {},
    checkedAt: "synthetic",
    checkedHeight: "100",
  };
  const u = {
    schema: "gonka24/forward-unsigned/1" as const,
    operation: op,
    publicKey: Buffer.from(a.pubkey).toString("base64"),
    sequence: "3",
    accountNumber: "2",
    gas: "100",
    fee: "100",
    tx: null as any,
  };
  u.tx = txJson(op, u.sequence, u.publicKey, u.gas, u.fee);
  const raw = wire(u),
    doc = SignDoc.fromPartial({
      bodyBytes: raw.bodyBytes,
      authInfoBytes: raw.authInfoBytes,
      chainId: deployment.chainId,
      accountNumber: 2n,
    });
  const signed = await wallet.signDirect(a.address, doc);
  raw.signatures = [Buffer.from(signed.signature.signature, "base64")];
  const bytes = Buffer.from(TxRaw.encode(raw).finish()).toString("base64");
  assert.equal(
    (await verifySigned(u, bytes)).schema,
    "gonka24/forward-signed/1",
  );
  for (const mutate of [
    (x: any) => (x.operation.messages[0].value.msg = { refund: {} }),
    (x: any) => (x.fee = "101"),
    (x: any) => (x.sequence = "4"),
    (x: any) => (x.accountNumber = "4"),
    (x: any) => (x.operation.deployment.chainId = "wrong"),
  ]) {
    const changed = structuredClone(u);
    mutate(changed);
    changed.tx = txJson(
      changed.operation,
      changed.sequence,
      changed.publicKey,
      changed.gas,
      changed.fee,
    );
    await assert.rejects(verifySigned(changed, bytes));
  }
});
test("block scan confirms without transaction index and checks included result", async () => {
  const bytes = Buffer.from("synthetic transaction").toString("base64"),
    h = hash(Buffer.from(bytes, "base64"));
  const c = new Chain(deployment);
  c.tip = async () => "100";
  let code: any = 0;
  c.rpc = async (path) =>
    path.startsWith("block?")
      ? {
          result: {
            block: {
              header: { height: "100", chain_id: deployment.chainId },
              data: { txs: [bytes] },
            },
            block_id: { hash: "synthetic" },
          },
        }
      : { result: { height: "100", txs_results: [{ code }] } };
  assert.equal((await confirm(c, h, "100", 100)).status, "INCLUDED");
  code = 5;
  assert.equal((await confirm(c, h, "100", 100)).status, "FAILED");
  for (const missing of [null, false, "", undefined]) {
    code = missing;
    await assert.rejects(confirm(c, h, "100", 100));
  }
});
test("missing block result never passes confirmation", async () => {
  const b = Buffer.from("synthetic").toString("base64"),
    c = new Chain(deployment);
  c.tip = async () => "100";
  c.rpc = async (p) =>
    p.startsWith("block?")
      ? {
          result: {
            block: {
              header: { height: "100", chain_id: deployment.chainId },
              data: { txs: [b] },
            },
          },
        }
      : { result: { height: "100", txs_results: [] } };
  await assert.rejects(
    confirm(c, hash(Buffer.from(b, "base64")), "100", 10),
    /missing/,
  );
});
test("confirmation timeout returns resume cursor without submission", async () => {
  const c = new Chain(deployment);
  c.tip = async () => "99";
  const r: any = await confirm(c, "a".repeat(64), "100", 1);
  assert.equal(r.status, "INCOMPLETE");
  assert.equal(r.nextHeight, "100");
});
test("deployment verification refuses runtime change before any contract checks", async () => {
  const c = new Chain(deployment, async (url) =>
    url.endsWith("/status")
      ? {
          result: {
            node_info: { network: deployment.chainId },
            sync_info: {
              catching_up: false,
              latest_block_time: new Date().toISOString(),
              latest_block_height: "100",
            },
          },
        }
      : { application_version: { git_commit: "wrong" } },
  );
  await assert.rejects(c.verify(), /runtime differs/);
});
test("missing native routing response is incomplete rather than agreement", async () => {
  const c = new Chain(deployment, async () => ({}));
  await assert.rejects(c.routes(A), /missing entries/);
});

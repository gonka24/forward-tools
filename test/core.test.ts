/** Synthetic fixtures only. No network, Docker, or live chain calls. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DirectSecp256k1Wallet } from "@cosmjs/proto-signing";
import { Secp256k1, Secp256k1Signature, sha256 } from "@cosmjs/crypto";
import { toBech32 } from "@cosmjs/encoding";
import { TxRaw, SignDoc } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { Chain, hash, validateDeployment } from "../src/chain.js";
import {
  decimal,
  economics,
  ToolError,
  Deployment,
  Operation,
} from "../src/model.js";
import { ROUTE, CLAIM, encodeNative, decodeNative } from "../src/native.js";
import { prepare, revalidate, status } from "../src/operations.js";
import {
  wire,
  verifySigned,
  txJson,
  confirm,
  confirmReceipt,
  broadcast,
  exportTx,
  checkFresh,
  reconcile,
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
  // Malleate S to n - S: still valid ECDSA, accepted by cosmjs, rejected by Cosmos SDK.
  const order =
      0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n,
    low = raw.signatures[0],
    s = BigInt("0x" + Buffer.from(low.subarray(32)).toString("hex")),
    high = Buffer.concat([
      low.subarray(0, 32),
      Buffer.from((order - s).toString(16).padStart(64, "0"), "hex"),
    ]);
  assert.equal(
    await Secp256k1.verifySignature(
      Secp256k1Signature.fromFixedLength(high),
      sha256(SignDoc.encode(doc).finish()),
      a.pubkey,
    ),
    true,
  );
  raw.signatures = [high];
  await assert.rejects(
    verifySigned(u, Buffer.from(TxRaw.encode(raw).finish()).toString("base64")),
    { code: "INVALID_SIGNATURE", message: /High-S/ },
  );
});
test("broadcast persists identity before submission and height zero never means inclusion", async () => {
  const { c } = fixture("funded", 10);
  const wallet = await DirectSecp256k1Wallet.fromKey(
    new Uint8Array(32).fill(8),
    "gonka",
  );
  const [a] = await wallet.getAccounts();
  c.account = async () => ({ account_number: "2", sequence: "3" });
  let submitted = 0,
    mode = "accepted";
  c.api = async (path) => {
    if (path.endsWith("simulate")) return { gas_info: { gas_used: "10" } };
    submitted++;
    if (mode === "unknown")
      throw new ToolError("RPC_UNAVAILABLE", "synthetic interrupted response");
    return { tx_response: { txhash: digest, code: 0, height: "0" } };
  };
  const op = await prepare(c, "lock", a.address, { deal: D });
  const u = await exportTx(c, op, Buffer.from(a.pubkey).toString("base64"));
  const raw = wire(u);
  const signed = await wallet.signDirect(
    a.address,
    SignDoc.fromPartial({
      bodyBytes: raw.bodyBytes,
      authInfoBytes: raw.authInfoBytes,
      chainId: deployment.chainId,
      accountNumber: 2n,
    }),
  );
  raw.signatures = [Buffer.from(signed.signature.signature, "base64")];
  const raw64 = Buffer.from(TxRaw.encode(raw).finish()).toString("base64");
  const digest = hash(Buffer.from(raw64, "base64")).toUpperCase();
  const s = await verifySigned(u, raw64);
  await assert.rejects(
    broadcast(c, s, async () => {
      throw new Error("synthetic disk failure");
    }),
    /disk failure/,
  );
  assert.equal(submitted, 0);
  const records: any[] = [];
  const save = async (r: any) => {
    records.push(structuredClone(r));
  };
  assert.equal((await broadcast(c, s, save)).status, "SUBMITTED");
  assert.equal(records[0].status, "SUBMISSION_UNKNOWN");
  assert.equal(records[0].txHash, digest);
  assert.equal(records[0].fromHeight, "100");
  assert.equal(records[1].response.height, "0");
  mode = "unknown";
  records.length = 0;
  await assert.rejects(broadcast(c, s, save), /interrupted/);
  assert.equal(records.length, 1);
  assert.equal(records[0].status, "SUBMISSION_UNKNOWN");
  assert.equal(submitted, 2);
});
/** A signed Lock for the funded fixture; `reply` sets the synthetic broadcast response. */
async function signedLock() {
  const f = fixture("funded", 10),
    wallet = await DirectSecp256k1Wallet.fromKey(
      new Uint8Array(32).fill(8),
      "gonka",
    ),
    [a] = await wallet.getAccounts();
  let response: any;
  f.c.account = async () => ({ account_number: "2", sequence: "3" });
  f.c.api = async (path) =>
    path.endsWith("simulate") ? { gas_info: { gas_used: "10" } } : response;
  const u = await exportTx(
    f.c,
    await prepare(f.c, "lock", a.address, { deal: D }),
    Buffer.from(a.pubkey).toString("base64"),
  );
  const raw = wire(u),
    signed = await wallet.signDirect(
      a.address,
      SignDoc.fromPartial({
        bodyBytes: raw.bodyBytes,
        authInfoBytes: raw.authInfoBytes,
        chainId: deployment.chainId,
        accountNumber: 2n,
      }),
    );
  raw.signatures = [Buffer.from(signed.signature.signature, "base64")];
  const raw64 = Buffer.from(TxRaw.encode(raw).finish()).toString("base64");
  return {
    c: f.c,
    state: f.s,
    signedTx: await verifySigned(u, raw64),
    raw64,
    digest: hash(Buffer.from(raw64, "base64")).toUpperCase(),
    reply: (r: any) => (response = r),
  };
}
test("re-broadcast of bytes the node already holds stays unknown and points to confirmation", async () => {
  const { c, signedTx, digest, reply } = await signedLock();
  const records: any[] = [];
  const save = async (r: any) => {
    records.push(structuredClone(r));
  };
  reply({ tx_response: { txhash: digest, code: 19, codespace: "sdk" } });
  const receipt = await broadcast(c, signedTx, save);
  assert.equal(receipt.status, "SUBMISSION_UNKNOWN");
  assert.match(receipt.reason, /do not resubmit/);
  assert.equal(records.at(-1).status, "SUBMISSION_UNKNOWN");
  assert.equal(records.at(-1).response.code, 19);
  // The same number from another module's codespace is an ordinary rejection.
  reply({
    tx_response: {
      txhash: digest,
      code: 19,
      codespace: "wasm",
      raw_log: "synthetic",
    },
  });
  await assert.rejects(broadcast(c, signedTx, save), { code: "TX_REJECTED" });
  assert.equal(records.at(-1).status, "REJECTED");
});
test("resumed confirmation keeps broadcast height, drops stale cursor fields and records postcondition failures", async () => {
  const { c, state, signedTx, raw64, digest, reply } = await signedLock();
  reply({ tx_response: { txhash: digest, code: 0, height: "0" } });
  const receipt = await broadcast(c, signedTx, async () => {});
  c.tip = async () => "101";
  c.rpc = async (path) => {
    const height = path.split("=")[1];
    return path.startsWith("block?")
      ? {
          result: {
            block: {
              header: { height, chain_id: deployment.chainId },
              data: { txs: height === "101" ? [raw64] : [] },
            },
          },
        }
      : { result: { height, txs_results: [{ code: 0 }] } };
  };
  // JSON round-trips model the files passed between CLI runs.
  const first = await confirmReceipt(
    c,
    JSON.parse(JSON.stringify(receipt)),
    10000,
    1,
  );
  assert.equal(first.status, "INCOMPLETE");
  assert.equal(first.code, "SCAN_LIMIT");
  assert.equal(first.nextHeight, "101");
  assert.equal(first.fromHeight, "100");
  const saved = JSON.parse(JSON.stringify(first));
  const resumed = await confirmReceipt(c, saved, 10000, 1);
  assert.equal(resumed.status, "INCLUDED");
  assert.equal(resumed.height, "101");
  assert.equal(resumed.fromHeight, "100");
  assert.equal(resumed.scanFromHeight, "101");
  for (const stale of ["code", "reason", "nextHeight"])
    assert.equal(resumed[stale], undefined, stale);
  // The fixture Deal is not locked: the failure is recorded, inclusion is kept.
  assert.equal(resumed.postcondition.status, "UNVERIFIED");
  assert.equal(resumed.postcondition.code, "POSTCONDITION_FAILED");
  state.recipient_locked = true;
  assert.equal(
    (await confirmReceipt(c, saved, 10000, 1)).postcondition.status,
    "RESULT_VERIFIED",
  );
  const tampered = structuredClone(saved);
  tampered.txHash = "A".repeat(64);
  await assert.rejects(confirmReceipt(c, tampered), {
    code: "RECEIPT_BINDING",
  });
});

test("completed state with missing native vesting data is incomplete rather than fully observed", async () => {
  const { c } = fixture("completed", 12);
  const baseline = {
    remaining_vesting_ngonka: "5",
    liquid_balance_ngonka: "100",
  };
  c.smart = async () => baseline;
  const complete = await status(c, D);
  assert.equal(complete.status, "OBSERVED");
  assert.equal(complete.native.remaining_vesting_ngonka, "5");
  assert.match(complete.note, /end of vesting/);
  const missing: any = structuredClone(baseline);
  delete missing.remaining_vesting_ngonka;
  c.smart = async () => missing;
  assert.equal((await status(c, D)).status, "INCOMPLETE");
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
test("only the pinned native claim simulation defect accepts an explicit owner gas limit", async () => {
  const { c } = fixture("locked", 11);
  c.deployment = {
    ...deployment,
    gonkaSha: "136041c81ea8ff38e7620d76af66a7c7fe7eec50",
  };
  const wallet = await DirectSecp256k1Wallet.fromKey(
    new Uint8Array(32).fill(12),
    "gonka",
  );
  const [a] = await wallet.getAccounts();
  // The host in this fixture is A; the export key must still match the participant.
  const k = (await c.deal(D)).config;
  k.host = a.address;
  c.account = async () => ({ account_number: "2", sequence: "3" });
  c.balance = async () => "2000000";
  const op = await prepare(c, "claim", a.address, { deal: D, seed: "7" });
  let error =
    "getMustBeValidatedInferences msg_server_claim_rewards.go:461 slice bounds out of range [:8] with capacity 0";
  c.api = async () => {
    throw new ToolError("RPC_ERROR", error);
  };
  const pub = Buffer.from(a.pubkey).toString("base64");
  await assert.rejects(exportTx(c, op, pub), /explicit --claim-gas/);
  const u = await exportTx(c, op, pub, "10000000", "1000000");
  assert.equal(u.gas, "1000000");
  assert.equal(u.gasReview?.kind, "pinned-claim-simulation-panic");
  await checkFresh(c, u);
  await assert.rejects(exportTx(c, op, pub, "999999", "1000000"), /fee limit/);
  error = "synthetic RPC outage";
  await assert.rejects(exportTx(c, op, pub, "10000000", "1000000"), /outage/);
  error = "claim seed signature invalid";
  await assert.rejects(
    exportTx(c, op, pub, "10000000", "1000000"),
    /seed signature/,
  );
  const changed = structuredClone(u);
  changed.gasReview!.warning = "synthetic false claim of verified eligibility";
  await assert.rejects(checkFresh(c, changed), /gas review differs/);
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
  const r = await confirm(c, "a".repeat(64), "100", 1);
  assert.equal(r.status, "INCOMPLETE");
  assert.equal(r.code, "CONFIRMATION_TIMEOUT");
  assert.equal(r.txHash, "A".repeat(64));
  assert.equal(r.nextHeight, "100");
});

test("block scan limit returns a persistable cursor that finds the transaction on resume without rescanning", async () => {
  const bytes = Buffer.from("synthetic delayed transaction").toString("base64"),
    h = hash(Buffer.from(bytes, "base64")),
    c = new Chain(deployment),
    scanned: string[] = [];
  c.tip = async () => "102";
  c.rpc = async (path) => {
    const height = path.split("=")[1];
    if (path.startsWith("block?")) {
      scanned.push(height);
      return {
        result: {
          block: {
            header: { height, chain_id: deployment.chainId },
            data: { txs: height === "102" ? [bytes] : [] },
          },
        },
      };
    }
    return { result: { height, txs_results: [{ code: 0 }] } };
  };
  const first = await confirm(c, h, "100", 10000, 2);
  assert.equal(first.status, "INCOMPLETE");
  assert.equal(first.code, "SCAN_LIMIT");
  assert.equal(first.nextHeight, "102");
  assert.deepEqual(scanned, ["100", "101"]);
  // JSON round-trip models the saved CLI result used as the next receipt.
  const saved = JSON.parse(JSON.stringify(first));
  const resumed = await confirm(c, saved.txHash, saved.nextHeight, 10000, 2);
  assert.equal(resumed.status, "INCLUDED");
  assert.equal(resumed.height, "102");
  assert.deepEqual(scanned, ["100", "101", "102"]);
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
test("rewards cannot be routed or claimed into a cancelled Deal, but a mistaken route can be removed", async () => {
  // Cancelled has no release, refund or settlement path: routed GNK would be stranded.
  const before = fixture("cancelled", 9);
  await assert.rejects(prepare(before.c, "route", A, { deal: D }), {
    code: "STATE_GUARD",
  });
  const removal = await prepare(before.c, "remove-route", A, { deal: D });
  assert.equal(removal.messages[0].value.entries[0].recipient, "");
  const after = fixture("cancelled", 11);
  await assert.rejects(prepare(after.c, "claim", A, { deal: D, seed: "7" }), {
    code: "STATE_GUARD",
  });
});
test("malformed caller input is rejected before any network query", async () => {
  const { c } = fixture("locked", 11);
  let queries = 0;
  c.verify = async () => {
    queries++;
    return { status: "VERIFIED", deployment: "synthetic", observations: [] };
  };
  for (const [action, input, code] of [
    ["claim", { deal: D, seed: "1.5" }, "INVALID_SEED"],
    ["withdraw", { deal: D, role: "admin" }, "INVALID_ROLE"],
    ["create-offer", { epoch: 11, price: "0", budget: "1" }, "INVALID_AMOUNT"],
    ["create-offer", { epoch: "11", price: "1", budget: "1" }, "INVALID_EPOCH"],
  ] as const)
    await assert.rejects(prepare(c, action, A, input), { code });
  assert.equal(queries, 0);
});
test("status never reads a missing pending payment as zero", async () => {
  const { c, k, s } = fixture("completed", 12);
  c.smart = async () => ({
    remaining_vesting_ngonka: "0",
    liquid_balance_ngonka: "0",
  });
  c.deal = async () => ({
    config: k,
    state: s,
    payments: {
      host: { pending_micro_usdt: "" },
      fee: { pending_micro_usdt: "0" },
      buyer: { pending_micro_usdt: "0" },
    },
  });
  await assert.rejects(status(c, D), { code: "INVALID_AMOUNT" });
});
test("routing postcondition tolerates pruning of past rows but not changes to other future rows", async () => {
  const { c, setRoutes } = fixture("open", 9);
  setRoutes([
    { epoch: "8", recipient: B },
    { epoch: "12", recipient: B },
  ]);
  const op = await prepare(c, "route", A, { deal: D });
  // Epoch 8 is not in the future, so only native pruning can remove it.
  setRoutes([
    { epoch: "10", recipient: D },
    { epoch: "12", recipient: B },
  ]);
  assert.equal((await reconcile(c, op)).status, "RESULT_VERIFIED");
  for (const routes of [
    [{ epoch: "12", recipient: B }],
    [
      { epoch: "10", recipient: D },
      { epoch: "12", recipient: A },
    ],
    [{ epoch: "10", recipient: D }],
  ]) {
    setRoutes(routes);
    await assert.rejects(reconcile(c, op), { code: "POSTCONDITION_FAILED" });
  }
});
test("deployment documents with missing pins or no nodes cannot verify vacuously", async () => {
  let fetched = 0;
  const empty = new Chain({ ...deployment, nodes: [] }, async () => {
    fetched++;
    return {};
  });
  await assert.rejects(empty.verify(), { code: "INVALID_DEPLOYMENT" });
  assert.equal(fetched, 0);
  for (const change of [
    { id: "../mainnet-v1" },
    { chainId: "" },
    { nodes: ["ftp://synthetic.invalid"] },
    { nodes: ["https://synthetic.invalid/"] },
    { gonkaSha: "A".repeat(40) },
    { dealHash: "d".repeat(63) },
    { factoryCodeId: "1" },
    { feeBps: 10001 },
    { factory: deployment.factory.toUpperCase() },
    { token: "gonka1invalid" },
  ])
    assert.throws(() => validateDeployment({ ...deployment, ...change }), {
      code: "INVALID_DEPLOYMENT",
    });
  const registry = JSON.parse(
    readFileSync(
      new URL("../../deployments/mainnet-v1.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(validateDeployment(registry).id, "mainnet-v1");
});

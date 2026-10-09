/** Synthetic fixtures only. No network, Docker, or live chain calls. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DirectSecp256k1Wallet } from "@cosmjs/proto-signing";
import { toBech32 } from "@cosmjs/encoding";
import { Chain, hash } from "../src/chain.js";
import { Deployment, signed64, ToolError, wireUint } from "../src/model.js";
import { CLAIM, encodeNative, decodeNative } from "../src/native.js";
import { prepare } from "../src/operations.js";
import { exportTx, checkFresh, wire } from "../src/transactions.js";
const addr = toBech32("gonka", new Uint8Array(20).fill(9));
const contract = toBech32("gonka", new Uint8Array(32).fill(10));
test("missing or coerced network scalars cannot become success or epoch zero", () => {
  for (const value of [
    null,
    undefined,
    false,
    true,
    "",
    "00",
    " 0",
    -1,
    {},
    [],
    1.5,
  ])
    assert.throws(() => wireUint(value), /network scalar/);
  assert.equal(wireUint("0"), 0);
  assert.equal(wireUint(9), 9);
});
test("usage errors are distinct from incomplete network checks", () => {
  assert.equal(new ToolError("USAGE", "synthetic option").exitCode, 2);
  assert.equal(
    new ToolError("INCOMPLETE", "synthetic missing fact").exitCode,
    1,
  );
});
const d: Deployment = {
  id: "synthetic",
  chainId: "synthetic-chain",
  nodes: ["http://synthetic.invalid"],
  gonkaSha: "a".repeat(40),
  contractsSha: "b".repeat(40),
  factory: contract,
  factoryCodeId: 1,
  dealCodeId: 2,
  token: contract,
  feeRecipient: addr,
  factoryHash: "c".repeat(64),
  dealHash: "d".repeat(64),
  tokenHash: "e".repeat(64),
  feeBps: 150,
  protoSha: "f".repeat(40),
  evidence: "synthetic",
};
test("signed claim seed supports full native int64 range", () => {
  for (const v of ["0", "-1", "-9223372036854775808", "9223372036854775807"]) {
    assert.equal(signed64(v), v);
    assert.equal(
      decodeNative(
        CLAIM,
        encodeNative(CLAIM, { creator: "x", seed: v, epoch_index: "42" }),
      ).seed,
      v,
    );
  }
  for (const v of ["-0", "9223372036854775808", "-9223372036854775809", "1.2"])
    assert.throws(() => signed64(v));
});
test("browser reusable core has no Node builtins or Buffer dependency", () => {
  for (const file of [
    "chain",
    "operations",
    "transactions",
    "native",
    "model",
  ]) {
    const code = readFileSync(
      new URL(`../../src/${file}.ts`, import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(code, /from ["']node:|\bBuffer\./);
  }
});
test("export simulates and builds direct signing payload without any wallet executable", async () => {
  const w = await DirectSecp256k1Wallet.fromKey(
      new Uint8Array(32).fill(8),
      "gonka",
    ),
    [a] = await w.getAccounts(),
    pub = Buffer.from(a.pubkey).toString("base64"),
    c = new Chain(d);
  c.verify = async () => ({
    status: "VERIFIED",
    deployment: d.id,
    observations: [],
  });
  c.tip = async () => "100";
  c.currentEpoch = async () => 10;
  c.host = async () => ({ index: a.address });
  c.account = async () => ({
    "@type": "/cosmos.auth.v1beta1.BaseAccount",
    address: a.address,
    account_number: "2",
    sequence: "3",
    pub_key: { "@type": "/cosmos.crypto.secp256k1.PubKey", key: pub },
  });
  c.api = async () => ({ gas_info: { gas_used: "100" } });
  c.balance = async () => "1000";
  const op = await prepare(c, "create-offer", a.address, {
      epoch: 11,
      price: "1000000",
      budget: "100000000",
    }),
    u = await exportTx(c, op);
  assert.equal(u.gas, "130");
  assert.equal(u.signDoc?.chainId, d.chainId);
  assert.equal(u.signDoc?.accountNumber, "2");
  assert.equal(u.tx.auth_info.fee.amount[0].amount, "130");
  const oversized = structuredClone(u);
  oversized.gas = "18446744073709551616";
  assert.throws(() => wire(oversized), /overflow/);
  await assert.rejects(exportTx(c, op, undefined, "129"), /fee limit/);
  c.account = async () => ({ account_number: "2", sequence: "4" });
  await assert.rejects(checkFresh(c, u), /sequence changed/);
});
test("code verification hashes downloaded bytes rather than trusting metadata", async () => {
  const bytes = Buffer.from("synthetic wasm"),
    h = hash(bytes),
    c = new Chain(d, async () => ({
      data: bytes.toString("base64"),
      code_info: { data_hash: h },
    }));
  await c.code(1, h);
  await assert.rejects(c.code(1, "f".repeat(64)), /checksum differs/);
});
for (const mutation of [
  "admin",
  "code",
  "creator",
  "factory",
  "token",
  "proto",
  "registry",
])
  test(`Deal verification rejects changed ${mutation}`, async () => {
    const config: any = {
      factory: d.factory,
      host: addr,
      deal_address: addr,
      target_epoch: 10,
      settlement_cw20: d.token,
      fee_recipient: d.feeRecipient,
      fee_bps: 150,
      pinned_gonka_sha: d.protoSha,
    };
    const info: any = {
      code_id: String(d.dealCodeId),
      admin: "",
      creator: d.factory,
    };
    let index = addr;
    if (mutation === "admin") info.admin = addr;
    if (mutation === "code") info.code_id = "999";
    if (mutation === "creator") info.creator = addr;
    if (mutation === "factory") config.factory = addr;
    if (mutation === "token") config.settlement_cw20 = addr;
    if (mutation === "proto") config.pinned_gonka_sha = "0".repeat(40);
    if (mutation === "registry") index = d.factory;
    const c = new Chain(d);
    c.info = async () => info;
    c.smart = async (_a, msg) =>
      msg.config ? config : msg.deal_by_host_epoch ? { address: index } : {};
    await assert.rejects(c.deal(addr));
  });
test("missing participant cannot be presented as verified host", async () => {
  const c = new Chain(d, async () => ({ participant: {} }));
  await assert.rejects(c.host(addr), /identity/);
});
test("request error is surfaced without automatically switching signing context", async () => {
  const c = new Chain(d, async () => {
    throw new ToolError("RPC_UNAVAILABLE", "synthetic outage");
  });
  await assert.rejects(c.currentEpoch(), /outage/);
});

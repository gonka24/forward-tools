/** Synthetic fixtures only. No network, Docker, or live chain calls. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DirectSecp256k1Wallet } from "@cosmjs/proto-signing";
import { toBech32, toBase64, fromBase64 } from "@cosmjs/encoding";
import { TxRaw, SignDoc } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { Chain } from "../src/chain.js";
import { Operation, Deployment, Unsigned } from "../src/model.js";
import { readiness } from "../src/readiness.js";
import { wire, txJson, verifySigned } from "../src/transactions.js";
import { EXEC } from "../src/operations.js";
import { ROUTE, CLAIM } from "../src/native.js";
const a = toBech32("gonka", new Uint8Array(20).fill(11));
const d: Deployment = {
  id: "synthetic",
  chainId: "synthetic-chain",
  nodes: ["http://synthetic.invalid"],
  gonkaSha: "a".repeat(40),
  contractsSha: "b".repeat(40),
  factory: a,
  factoryCodeId: 1,
  dealCodeId: 2,
  token: a,
  feeRecipient: a,
  factoryHash: "c".repeat(64),
  dealHash: "d".repeat(64),
  tokenHash: "e".repeat(64),
  feeBps: 150,
  protoSha: "f".repeat(40),
  evidence: "synthetic",
};
function chain() {
  const c = new Chain(d);
  c.verify = async () => ({
    status: "VERIFIED",
    deployment: d.id,
    observations: [],
  });
  c.host = async () => ({ index: a });
  c.balance = async () => "10000";
  c.routes = async () => [];
  c.currentEpoch = async () => 10;
  return c;
}
test("readiness reports missing commercial terms and signing proof without awarding readiness", async () => {
  const r = await readiness(chain(), { host: a, signer: a });
  assert.equal(r.status, "INCOMPLETE");
  assert.equal(r.commercialTermsAgreed, false);
  assert.equal(r.signingCapabilitiesVerified, false);
  assert.equal(r.signed, false);
  assert.equal(r.included, false);
});
test("readiness rejects zero economic terms and expired epoch", async () => {
  await assert.rejects(
    readiness(chain(), {
      host: a,
      signer: a,
      price: "1",
      budget: "0",
      targetEpoch: 11,
    }),
    /positive/,
  );
  const r = await readiness(chain(), {
    host: a,
    signer: a,
    price: "1",
    budget: "10",
    targetEpoch: 10,
  });
  assert.ok(r.blockers.includes("Target epoch outside future window"));
});
test("readiness distinguishes failed environment from host absence", async () => {
  const c = chain();
  c.verify = async () => {
    throw new Error("synthetic failure");
  };
  const r = await readiness(c, { host: a });
  assert.equal(r.environmentReady, false);
  assert.equal(r.hostVerified, false);
  assert.equal(r.status, "INCOMPLETE");
});
test("owner signatures prove supported message formats without authorizing broadcast", async () => {
  const w = await DirectSecp256k1Wallet.fromKey(
      new Uint8Array(32).fill(12),
      "gonka",
    ),
    [owner] = await w.getAccounts(),
    proofs = [];
  for (const [typeUrl, value] of [
    [
      EXEC,
      { sender: owner.address, contract: a, msg: { lock: {} }, funds: [] },
    ],
    [
      ROUTE,
      { creator: owner.address, entries: [{ epoch: "11", recipient: a }] },
    ],
    [CLAIM, { creator: owner.address, seed: "7", epoch_index: "11" }],
  ] as const) {
    const op: Operation = {
      schema: "gonka24/forward-operation/1",
      deployment: d,
      sender: owner.address,
      action: "lock",
      input: {},
      messages: [{ typeUrl, value }],
      terms: {},
      checkedAt: "synthetic",
      checkedHeight: "100",
    };
    const u: Unsigned = {
      schema: "gonka24/forward-unsigned/1",
      operation: op,
      tx: null,
      accountNumber: "1",
      sequence: "0",
      publicKey: toBase64(owner.pubkey),
      gas: "100",
      fee: "100",
    };
    u.tx = txJson(op, u.sequence, u.publicKey, u.gas, u.fee);
    const raw = wire(u),
      doc = SignDoc.fromPartial({
        bodyBytes: raw.bodyBytes,
        authInfoBytes: raw.authInfoBytes,
        chainId: d.chainId,
        accountNumber: 1n,
      }),
      signed = await w.signDirect(owner.address, doc);
    raw.signatures = [fromBase64(signed.signature.signature)];
    proofs.push(await verifySigned(u, toBase64(TxRaw.encode(raw).finish())));
  }
  const r = await readiness(chain(), {
    host: owner.address,
    signer: owner.address,
    price: "1",
    budget: "10",
    targetEpoch: 11,
    proofs,
  });
  assert.equal(r.status, "READY");
  assert.equal(r.signingCapabilitiesVerified, true);
  assert.equal(r.signed, false);
  assert.equal(r.included, false);
  assert.doesNotMatch(JSON.stringify(r), /keyring|\/home\//);
  await assert.rejects(readiness(chain(), { host: a, proofs }), /belong/);
});
test("developer participant row does not establish a compute host", async () => {
  const c = new Chain(d, async () => ({
    participant: {
      index: a,
      address: a,
      weight: -1,
      status: "ACTIVE",
      inference_url: "",
    },
  }));
  await assert.rejects(c.host(a), /developer accounts/);
});
test("active registered compute host identity is accepted without claiming future earnings", async () => {
  const c = new Chain(d, async () => ({
    participant: {
      index: a,
      address: a,
      weight: 0,
      status: "ACTIVE",
      inference_url: "http://synthetic.invalid",
    },
  }));
  assert.equal((await c.host(a)).weight, 0);
});

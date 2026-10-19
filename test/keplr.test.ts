/** Synthetic wallets and fixtures only. No network, extension, Docker or live chain calls. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Long from "long";
import { toBase64 } from "@cosmjs/encoding";
import { DirectSecp256k1Wallet } from "@cosmjs/proto-signing";
import { SignDoc } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { KeplrAdapter, KeplrProvider } from "../src/adapters/keplr.js";
import { Operation, Unsigned } from "../src/model.js";
import { txJson, verifySigned, wire } from "../src/transactions.js";
import { CLAIM, ROUTE } from "../src/native.js";

async function fixture(type?: string) {
  const wallet = await DirectSecp256k1Wallet.fromKey(
    new Uint8Array(32).fill(17),
    "gonka",
  );
  const [account] = await wallet.getAccounts();
  const op: Operation = JSON.parse(
    readFileSync(
      new URL("../../examples/operation.example.json", import.meta.url),
      "utf8",
    ),
  );
  delete op.test_fixture_only;
  op.sender = account.address;
  op.messages[0].value.sender = account.address;
  if (type === ROUTE) {
    op.action = "route";
    op.messages = [
      {
        typeUrl: ROUTE,
        value: {
          creator: account.address,
          entries: [{ epoch: "11", recipient: op.deployment.factory }],
        },
      },
    ];
  }
  if (type === CLAIM) {
    op.action = "claim";
    op.messages = [
      {
        typeUrl: CLAIM,
        value: { creator: account.address, seed: "0", epoch_index: "11" },
      },
    ];
  }
  const u: Unsigned = {
    schema: "gonka24/forward-unsigned/1",
    operation: op,
    accountNumber: "18446744073709551615",
    sequence: "3",
    publicKey: toBase64(account.pubkey),
    gas: "1000",
    fee: "1000",
    tx: null,
  };
  u.tx = txJson(op, u.sequence, u.publicKey, u.gas, u.fee);
  const raw = wire(u);
  u.signDoc = {
    bodyBytes: toBase64(raw.bodyBytes),
    authInfoBytes: toBase64(raw.authInfoBytes),
    chainId: op.deployment.chainId,
    accountNumber: u.accountNumber,
  };
  let calls = 0;
  const provider: KeplrProvider = {
    async enable(chain) {
      assert.equal(chain, op.deployment.chainId);
    },
    async getKey() {
      return {
        algo: "secp256k1",
        bech32Address: account.address,
        pubKey: account.pubkey,
      };
    },
    async signDirect(chain, sender, doc, options) {
      calls++;
      assert.equal(chain, op.deployment.chainId);
      assert.deepEqual(options, {
        preferNoSetFee: true,
        preferNoSetMemo: true,
      });
      assert.equal(doc.accountNumber.toString(), u.accountNumber);
      const result = await wallet.signDirect(
        sender,
        SignDoc.fromPartial({
          ...doc,
          accountNumber: BigInt(doc.accountNumber.toString()),
        }),
      );
      return {
        signed: {
          ...result.signed,
          accountNumber: Long.fromString(
            result.signed.accountNumber.toString(),
            true,
          ),
        },
        signature: result.signature,
      };
    },
  };
  return {
    u,
    provider,
    calls: () => calls,
    adapter: new KeplrAdapter(provider, op.deployment.chainId),
  };
}

for (const type of [undefined, ROUTE, CLAIM])
  test(`Keplr preserves exact direct bytes and full uint64 account for ${type ?? "execute"}`, async () => {
    const f = await fixture(type);
    const raw = await f.adapter.sign(f.u);
    await verifySigned(f.u, raw);
    assert.equal(f.calls(), 1);
  });

test("wrong chain and inconsistent unsigned document are rejected before wallet signature", async () => {
  const f = await fixture();
  await assert.rejects(
    new KeplrAdapter(f.provider, "another-chain").sign(f.u),
    { code: "WRONG_CHAIN" },
  );
  f.u.tx.auth_info.fee.gas_limit = "2000";
  await assert.rejects(f.adapter.sign(f.u), { code: "INVALID_UNSIGNED" });
  assert.equal(f.calls(), 0);
});

test("wallet account changes and unsupported hardware block signing", async () => {
  const f = await fixture();
  const get = f.provider.getKey;
  f.provider.getKey = async (chain) => ({
    ...(await get(chain)),
    isNanoLedger: true,
  });
  await assert.rejects(f.adapter.sign(f.u), { code: "WALLET_UNSUPPORTED" });
  f.provider.getKey = async (chain) => ({
    ...(await get(chain)),
    bech32Address: f.u.operation.deployment.feeRecipient,
  });
  await assert.rejects(f.adapter.sign(f.u), { code: "SIGNER_MISMATCH" });
  assert.equal(f.calls(), 0);
});

for (const changed of ["chain", "account", "body", "fee", "key"])
  test(`wallet change of ${changed} is rejected even when it returns a signature`, async () => {
    const f = await fixture();
    const sign = f.provider.signDirect;
    f.provider.signDirect = async (...args) => {
      const result = await sign(...args);
      if (changed === "chain") result.signed.chainId = "other";
      if (changed === "account") result.signed.accountNumber = Long.ZERO;
      if (changed === "body") result.signed.bodyBytes = new Uint8Array([1]);
      if (changed === "fee") result.signed.authInfoBytes = new Uint8Array([1]);
      if (changed === "key") result.signature.pub_key.value = "bad";
      return result;
    };
    await assert.rejects(f.adapter.sign(f.u), { code: "SIGNED_TX_CHANGED" });
  });

test("wallet refusal is distinct from extension failure and neither broadcasts", async () => {
  const f = await fixture();
  f.provider.signDirect = async () => {
    throw new Error("Request rejected");
  };
  await assert.rejects(f.adapter.sign(f.u), { code: "WALLET_REJECTED" });
  f.provider.signDirect = async () => {
    throw new Error("Disconnected");
  };
  await assert.rejects(f.adapter.sign(f.u), { code: "WALLET_FAILED" });
});

test("caller mutation during wallet interaction cannot replace the signed intent", async () => {
  const f = await fixture();
  const expected = structuredClone(f.u);
  const get = f.provider.getKey;
  f.provider.getKey = async (chain) => {
    f.u.operation.messages[0].value.msg = { cancel: {} };
    return get(chain);
  };
  const raw = await f.adapter.sign(f.u);
  await verifySigned(expected, raw);
});

test("example operation is refused before opening the wallet", async () => {
  const f = await fixture();
  f.u.operation.test_fixture_only = true;
  let enabled = false;
  f.provider.enable = async () => {
    enabled = true;
  };
  await assert.rejects(f.adapter.sign(f.u), { code: "TEST_FIXTURE" });
  assert.equal(enabled, false);
});

test("malformed wallet response has a stable failure code", async () => {
  const f = await fixture();
  f.provider.signDirect = async () => null as never;
  await assert.rejects(f.adapter.sign(f.u), {
    code: "WALLET_INVALID_RESPONSE",
  });
});

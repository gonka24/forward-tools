/** Synthetic fixtures only. No network, Docker, or live chain calls. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DirectSecp256k1Wallet } from "@cosmjs/proto-signing";
import { fromBase64, toBase64, toBech32 } from "@cosmjs/encoding";
import { SignDoc, TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { Chain, hash } from "../src/chain.js";
import { Deployment, ToolError, Unsigned } from "../src/model.js";
import { EXEC } from "../src/operations.js";
import { SigningAdapter, wire } from "../src/transactions.js";
import { ForwardClient, BroadcastReceipt, PrepareRequest } from "../src/sdk.js";

async function fixture() {
  const wallet = await DirectSecp256k1Wallet.fromKey(
    new Uint8Array(32).fill(17),
    "gonka",
  );
  const [account] = await wallet.getAccounts();
  const contract = toBech32("gonka", new Uint8Array(32).fill(18));
  const deployment: Deployment = {
    id: "synthetic",
    chainId: "synthetic-chain",
    nodes: ["http://synthetic.invalid"],
    gonkaSha: "a".repeat(40),
    contractsSha: "b".repeat(40),
    factory: contract,
    factoryCodeId: 1,
    dealCodeId: 2,
    token: contract,
    feeRecipient: account.address,
    factoryHash: "c".repeat(64),
    dealHash: "d".repeat(64),
    tokenHash: "e".repeat(64),
    feeBps: 150,
    protoSha: "f".repeat(40),
    evidence: "synthetic",
  };
  const chain = new Chain(deployment, async () => {
    throw new Error("Unexpected external boundary");
  });
  chain.verify = async () => ({
    status: "VERIFIED",
    deployment: "synthetic",
    observations: [],
  });
  chain.tip = async () => "100";
  chain.currentEpoch = async () => 9;
  chain.host = async () => ({ index: account.address });
  chain.account = async () => ({
    account_number: "2",
    sequence: "3",
    pub_key: {
      "@type": "/cosmos.crypto.secp256k1.PubKey",
      key: toBase64(account.pubkey),
    },
  });
  chain.balance = async () => "10000000";
  const submission: { calls: number; send: (body: any) => Promise<any> } = {
    calls: 0,
    send: async (body) => ({
      tx_response: {
        code: 0,
        txhash: hash(fromBase64(body.tx_bytes)).toUpperCase(),
      },
    }),
  };
  chain.api = async (path, body) => {
    if (path.endsWith("/simulate")) return { gas_info: { gas_used: "100" } };
    if (path.endsWith("/txs")) {
      submission.calls++;
      return submission.send(body);
    }
    throw new Error(`Unexpected synthetic API ${path}`);
  };
  const client = new ForwardClient(chain);
  const request: PrepareRequest = {
    action: "create-offer",
    sender: account.address,
    input: { epoch: 10, price: "1000000", budget: "100000000" },
  };
  const unsigned = await client.exportTx(await client.prepare(request));
  const signBytes = async (u: Unsigned) => {
    const raw = wire(u);
    const result = await wallet.signDirect(
      account.address,
      SignDoc.fromPartial({
        bodyBytes: raw.bodyBytes,
        authInfoBytes: raw.authInfoBytes,
        chainId: u.operation.deployment.chainId,
        accountNumber: BigInt(u.accountNumber),
      }),
    );
    raw.signatures = [fromBase64(result.signature.signature)];
    return toBase64(TxRaw.encode(raw).finish());
  };
  const adapter: SigningAdapter = {
    capabilities: { direct: true, typeUrls: [EXEC] },
    getAddress: async () => account.address,
    sign: signBytes,
  };
  return { chain, client, unsigned, adapter, submission, signBytes };
}

test("shared signer validates capability identity and freshness before requesting any signature", async () => {
  const f = await fixture();
  let calls = 0;
  const adapter = {
    ...f.adapter,
    sign: async () => {
      calls++;
      return "";
    },
  };
  await assert.rejects(
    f.client.sign(f.unsigned, {
      ...adapter,
      capabilities: { direct: false, typeUrls: [] },
    }),
    { code: "UNSUPPORTED_SIGNER" },
  );
  await assert.rejects(
    f.client.sign(f.unsigned, { ...adapter, getAddress: async () => "wrong" }),
    { code: "SIGNER_MISMATCH" },
  );
  f.chain.account = async () => ({ account_number: "2", sequence: "4" });
  await assert.rejects(f.client.sign(f.unsigned, adapter), {
    code: "STALE_TRANSACTION",
  });
  assert.equal(calls, 0);
});

test("common keeper adapter signs unchanged bytes and wallet rejection never submits", async () => {
  const f = await fixture();
  const signed = await f.client.sign(f.unsigned, f.adapter);
  assert.equal(signed.schema, "gonka24/forward-signed/1");
  await assert.rejects(
    f.client.sign(f.unsigned, {
      ...f.adapter,
      sign: async () => {
        throw new ToolError("USER_REJECTED", "synthetic rejection");
      },
    }),
    { code: "USER_REJECTED" },
  );
  assert.equal(f.submission.calls, 0);
});

test("adapter mutations cannot replace the reviewed signing reference", async () => {
  for (const mutate of [
    (u: Unsigned) => {
      u.operation.messages[0].value.msg = { refund: {} };
    },
    (u: Unsigned) => {
      u.fee = "131";
    },
    (u: Unsigned) => {
      u.operation.deployment.chainId = "another-chain";
    },
  ]) {
    const f = await fixture(),
      before = structuredClone(f.unsigned);
    await assert.rejects(
      f.client.sign(f.unsigned, {
        ...f.adapter,
        sign: async (u) => {
          mutate(u);
          return f.signBytes(u);
        },
      }),
    );
    assert.deepEqual(f.unsigned, before);
    assert.equal(f.submission.calls, 0);
  }
});

test("submission requires separate approval and durable receipt before contacting broadcast", async () => {
  const f = await fixture(),
    signed = await f.client.sign(f.unsigned, f.adapter);
  await assert.rejects(
    f.client.submit(signed, {
      approved: false,
      saveReceipt: async () => {},
    } as any),
    { code: "SUBMISSION_NOT_APPROVED" },
  );
  await assert.rejects(
    f.client.submit(signed, {
      approved: true,
      saveReceipt: async () => {
        throw new Error("disk failed");
      },
    }),
    /disk failed/,
  );
  assert.equal(f.submission.calls, 0);
  const saved: BroadcastReceipt[] = [];
  f.submission.send = async (body) => {
    assert.equal(saved[0].status, "SUBMISSION_UNKNOWN");
    return {
      tx_response: {
        code: 0,
        txhash: hash(fromBase64(body.tx_bytes)).toUpperCase(),
      },
    };
  };
  const result = await f.client.submit(signed, {
    approved: true,
    saveReceipt: async (r) => {
      saved.push(structuredClone(r));
      r.txHash = "caller mutation";
    },
  });
  assert.equal(result.status, "SUBMITTED");
  assert.equal(result.receipt.txHash, saved[0].txHash);
});

test("lost broadcast response returns same durable hash without automatic retry", async () => {
  const f = await fixture(),
    signed = await f.client.sign(f.unsigned, f.adapter);
  f.submission.send = async () => {
    throw new ToolError("RPC_UNAVAILABLE", "response lost");
  };
  const saved: BroadcastReceipt[] = [];
  const result = await f.client.submit(signed, {
    approved: true,
    saveReceipt: async (r) => {
      saved.push(r);
    },
  });
  assert.equal(result.status, "SUBMISSION_UNKNOWN");
  assert.equal(result.error?.code, "RPC_UNAVAILABLE");
  assert.equal(result.receipt.txHash, saved[0].txHash);
  assert.equal(f.submission.calls, 1);
});

test("explicit mempool rejection stays rejected and failure to persist acceptance stays uncertain", async () => {
  const f = await fixture(),
    signed = await f.client.sign(f.unsigned, f.adapter);
  f.submission.send = async (body) => ({
    tx_response: {
      code: 5,
      txhash: hash(fromBase64(body.tx_bytes)).toUpperCase(),
      raw_log: "synthetic rejection",
    },
  });
  const rejected = await f.client.submit(signed, {
    approved: true,
    saveReceipt: async () => {},
  });
  assert.equal(rejected.status, "REJECTED");
  assert.equal(rejected.error?.code, "TX_REJECTED");
  const other = await fixture(),
    another = await other.client.sign(other.unsigned, other.adapter);
  let saves = 0;
  const uncertain = await other.client.submit(another, {
    approved: true,
    saveReceipt: async () => {
      if (++saves === 2)
        throw new Error("synthetic storage outage after submission");
    },
  });
  assert.equal(uncertain.status, "SUBMISSION_UNKNOWN");
  assert.equal(other.submission.calls, 1);
});

test("confirmation preserves incomplete cursor and included but unverified operation", async () => {
  const f = await fixture(),
    signed = await f.client.sign(f.unsigned, f.adapter);
  const submitted = await f.client.submit(signed, {
    approved: true,
    saveReceipt: async () => {},
  });
  f.chain.rpc = async () => ({
    result: {
      block: {
        header: { chain_id: "synthetic-chain", height: "100" },
        data: {},
      },
    },
  });
  const incomplete = await f.client.confirm(submitted.receipt, {
    maxBlocks: 1,
  });
  assert.equal(incomplete.status, "INCOMPLETE");
  if (incomplete.status === "INCOMPLETE")
    assert.equal(incomplete.nextHeight, "100");
  f.chain.rpc = async (path) =>
    path.startsWith("block_results")
      ? { result: { height: "100", txs_results: [{ code: 0 }] } }
      : {
          result: {
            block: {
              header: { chain_id: "synthetic-chain", height: "100" },
              data: { txs: [signed.txRaw] },
            },
          },
        };
  f.chain.smart = async () => {
    throw new ToolError("RPC_UNAVAILABLE", "synthetic postcondition outage");
  };
  const included = await f.client.confirm(incomplete);
  assert.equal(included.status, "INCLUDED");
  if (included.status === "INCLUDED")
    assert.equal(included.postcondition.status, "UNVERIFIED");
  assert.equal(f.submission.calls, 1);
});

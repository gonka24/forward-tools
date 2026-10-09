import {
  Secp256k1,
  Secp256k1Signature,
  sha256,
  ripemd160,
} from "@cosmjs/crypto";
import { fromBase64, toBase64, toBech32, toUtf8 } from "@cosmjs/encoding";
import { Registry } from "@cosmjs/proto-signing";
import {
  TxRaw,
  TxBody,
  AuthInfo,
  SignDoc,
} from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { PubKey } from "cosmjs-types/cosmos/crypto/secp256k1/keys";
import { MsgExecuteContract } from "cosmjs-types/cosmwasm/wasm/v1/tx";
import { Chain, same, hash } from "./chain.js";
import {
  Message,
  Operation,
  Unsigned,
  Signed,
  requireFact,
  integer,
  wireUint,
} from "./model.js";
import { revalidate, EXEC } from "./operations.js";
import { encodeNative, ROUTE, CLAIM } from "./native.js";
const registry = new Registry([[EXEC, MsgExecuteContract]]);
export function encoded(m: Message) {
  return {
    typeUrl: m.typeUrl,
    value:
      m.typeUrl === EXEC
        ? registry.encode({
            typeUrl: m.typeUrl,
            value: {
              ...m.value,
              msg: toUtf8(JSON.stringify(m.value.msg)),
            },
          })
        : encodeNative(m.typeUrl, m.value),
  };
}
export function txJson(
  op: Operation,
  sequence: string,
  pubkey: string,
  gas: string,
  fee: string,
) {
  return {
    body: {
      messages: op.messages.map((m) => ({ "@type": m.typeUrl, ...m.value })),
      memo: "",
      timeout_height: "0",
      unordered: false,
      timeout_timestamp: null,
      extension_options: [],
      non_critical_extension_options: [],
    },
    auth_info: {
      signer_infos: [
        {
          public_key: {
            "@type": "/cosmos.crypto.secp256k1.PubKey",
            key: pubkey,
          },
          mode_info: { single: { mode: "SIGN_MODE_DIRECT" } },
          sequence,
        },
      ],
      fee: {
        amount: [{ denom: "ngonka", amount: fee }],
        gas_limit: gas,
        payer: "",
        granter: "",
      },
      tip: null,
    },
    // Cosmos SDK's JSON signer expects one empty signature slot per signer info.
    // It is not a signature; the external owner replaces it when signing.
    signatures: [""],
  };
}
export function wire(u: Unsigned): TxRaw {
  const body = TxBody.fromPartial({
    messages: u.operation.messages.map(encoded),
    memo: "",
    timeoutHeight: 0n,
  });
  const auth = AuthInfo.fromPartial({
    signerInfos: [
      {
        publicKey: {
          typeUrl: "/cosmos.crypto.secp256k1.PubKey",
          value: PubKey.encode({ key: fromBase64(u.publicKey) }).finish(),
        },
        modeInfo: { single: { mode: 1 } },
        sequence: BigInt(u.sequence),
      },
    ],
    fee: {
      amount: [{ denom: "ngonka", amount: u.fee }],
      gasLimit: BigInt(u.gas),
    },
  });
  return TxRaw.fromPartial({
    bodyBytes: TxBody.encode(body).finish(),
    authInfoBytes: AuthInfo.encode(auth).finish(),
    signatures: [],
  });
}
export function pubAddress(key: string) {
  const bytes = fromBase64(key);
  requireFact(
    bytes.length === 33,
    "INVALID_PUBLIC_KEY",
    "Compressed secp256k1 public key required",
  );
  return toBech32("gonka", ripemd160(sha256(bytes)));
}
export async function exportTx(
  c: Chain,
  op: Operation,
  publicKey?: string,
  maxFee = "10000000",
  claimGas?: string,
): Promise<Unsigned> {
  await revalidate(c, op);
  const a = await c.account(op.sender),
    pub = publicKey ?? a.pub_key?.key;
  requireFact(
    pub && pubAddress(pub) === op.sender,
    "SIGNER_MISMATCH",
    "Public key must match operation sender",
  );
  if (a.pub_key)
    requireFact(
      a.pub_key["@type"] === "/cosmos.crypto.secp256k1.PubKey" &&
        a.pub_key.key === pub,
      "SIGNER_MISMATCH",
      "On-chain public key differs",
    );
  const u: Unsigned = {
    schema: "gonka24/forward-unsigned/1",
    operation: op,
    tx: null,
    accountNumber: a.account_number,
    sequence: a.sequence,
    publicKey: pub,
    gas: "10000000",
    fee: "10000000",
  };
  const raw = wire(u);
  raw.signatures = [new Uint8Array(64)];
  const estimate = await estimateGas(c, u, raw, claimGas);
  const gas = estimate.gas;
  if (estimate.review) u.gasReview = estimate.review;
  requireFact(
    gas > 0n && gas <= integer(maxFee, "max fee"),
    "FEE_LIMIT",
    "Simulated fee exceeds explicit fee limit (1 ngonka/gas)",
  );
  requireFact(
    BigInt(await c.balance(op.sender)) >= gas,
    "INSUFFICIENT_GAS",
    "Signer GNK balance insufficient",
  );
  u.gas = gas.toString();
  u.fee = gas.toString();
  u.tx = txJson(op, u.sequence, pub, u.gas, u.fee);
  const final = wire(u);
  u.signDoc = {
    bodyBytes: toBase64(final.bodyBytes),
    authInfoBytes: toBase64(final.authInfoBytes),
    chainId: op.deployment.chainId,
    accountNumber: u.accountNumber,
  };
  return u;
}
const CLAIM_PANIC_WARNING =
  "Native claim simulation has no header hash in this pinned Gonka runtime. Owner supplied gas limit; native eligibility remains unproven until successful inclusion. A failed transaction may consume gas.";
async function estimateGas(
  c: Chain,
  u: Unsigned,
  raw: TxRaw,
  claimGas?: string,
) {
  if (claimGas !== undefined)
    requireFact(
      u.operation.action === "claim",
      "INVALID_GAS_REVIEW",
      "Explicit claim gas is only valid for native claim",
    );
  try {
    const sim = await c.api("/cosmos/tx/v1beta1/simulate", {
      tx_bytes: toBase64(TxRaw.encode(raw).finish()),
    });
    const used = integer(sim.gas_info?.gas_used, "simulation gas");
    return { gas: (used * 130n + 99n) / 100n };
  } catch (e) {
    const message = e instanceof Error ? e.message : "";
    // Only this source-confirmed simulation defect can use an owner-selected limit.
    // Outages, seed errors and other execution failures stay blocking errors.
    const known =
      u.operation.action === "claim" &&
      c.deployment.gonkaSha === "136041c81ea8ff38e7620d76af66a7c7fe7eec50" &&
      message.includes("getMustBeValidatedInferences") &&
      message.includes("msg_server_claim_rewards.go:461") &&
      message.includes("slice bounds out of range [:8] with capacity 0");
    if (!known) throw e;
    requireFact(
      claimGas !== undefined,
      "CLAIM_SIMULATION_UNAVAILABLE",
      "Pinned Gonka native claim simulation panics. Review explicit --claim-gas limit and its gas-loss risk before signing; no transaction was sent.",
    );
    const gas = integer(claimGas, "claim gas");
    requireFact(
      gas > 0n,
      "INVALID_GAS_REVIEW",
      "Positive owner-selected claim gas limit required",
    );
    return {
      gas,
      review: {
        kind: "pinned-claim-simulation-panic" as const,
        gasLimit: gas.toString(),
        warning: CLAIM_PANIC_WARNING,
      },
    };
  }
}
export async function verifySigned(
  u: Unsigned,
  raw64: string,
): Promise<Signed> {
  requireFact(
    u.schema === "gonka24/forward-unsigned/1" &&
      same(u.tx, txJson(u.operation, u.sequence, u.publicKey, u.gas, u.fee)),
    "INVALID_UNSIGNED",
    "Unsigned transaction disagrees with operation",
  );
  integer(u.accountNumber, "account", (1n << 64n) - 1n);
  integer(u.sequence, "sequence", (1n << 64n) - 1n);
  integer(u.gas, "gas");
  integer(u.fee, "fee");
  requireFact(
    BigInt(u.gas) > 0n &&
      u.gas === u.fee &&
      pubAddress(u.publicKey) === u.operation.sender,
    "SIGNER_MISMATCH",
    "Signer/fee metadata inconsistent",
  );
  const raw = TxRaw.decode(fromBase64(raw64)),
    expected = wire(u);
  requireFact(
    hash(raw.bodyBytes) === hash(expected.bodyBytes) &&
      hash(raw.authInfoBytes) === hash(expected.authInfoBytes),
    "SIGNED_TX_CHANGED",
    "Signed messages, memo, sequence, fee or signer differs",
  );
  requireFact(
    raw.signatures.length === 1 && raw.signatures[0].length === 64,
    "INVALID_SIGNATURE",
    "One secp256k1 signature required",
  );
  const signDoc = SignDoc.fromPartial({
    bodyBytes: raw.bodyBytes,
    authInfoBytes: raw.authInfoBytes,
    chainId: u.operation.deployment.chainId,
    accountNumber: BigInt(u.accountNumber),
  });
  requireFact(
    await Secp256k1.verifySignature(
      Secp256k1Signature.fromFixedLength(raw.signatures[0]),
      sha256(SignDoc.encode(signDoc).finish()),
      fromBase64(u.publicKey),
    ),
    "INVALID_SIGNATURE",
    "Signature does not bind expected chain/account",
  );
  return {
    schema: "gonka24/forward-signed/1",
    unsigned: u,
    txRaw: toBase64(TxRaw.encode(raw).finish()),
  };
}
export interface SigningAdapter {
  capabilities: { direct: boolean; typeUrls: string[] };
  getAddress(): Promise<string>;
  /** Returns signed TxRaw bytes as base64; no wallet-specific filesystem contract. */
  sign(unsigned: Unsigned): Promise<string>;
}
export async function checkFresh(c: Chain, u: Unsigned) {
  await revalidate(c, u.operation);
  const a = await c.account(u.operation.sender);
  requireFact(
    a.account_number === u.accountNumber && a.sequence === u.sequence,
    "STALE_TRANSACTION",
    "Account/sequence changed: export again, do not replay",
  );
  const sim = wire(u);
  sim.signatures = [new Uint8Array(64)];
  if (u.gasReview)
    requireFact(
      u.gasReview.kind === "pinned-claim-simulation-panic" &&
        u.gasReview.gasLimit === u.gas &&
        u.gasReview.warning === CLAIM_PANIC_WARNING &&
        u.fee === u.gas,
      "INVALID_GAS_REVIEW",
      "Explicit claim gas review differs",
    );
  const estimate = await estimateGas(c, u, sim, u.gasReview?.gasLimit);
  requireFact(
    estimate.gas <= BigInt(u.gas),
    "GAS_CHANGED",
    "Gas estimate changed: export again",
  );
}
export async function broadcast(
  c: Chain,
  s: Signed,
  save: (receipt: any) => Promise<void>,
) {
  requireFact(
    s.schema === "gonka24/forward-signed/1",
    "INVALID_SIGNED",
    "Wrong signed envelope",
  );
  await verifySigned(s.unsigned, s.txRaw);
  await checkFresh(c, s.unsigned);
  const fromHeight = await c.tip(),
    txHash = hash(fromBase64(s.txRaw)).toUpperCase();
  const receipt: any = {
    schema: "gonka24/forward-broadcast/1",
    status: "SUBMISSION_UNKNOWN",
    txHash,
    fromHeight,
    operation: s.unsigned.operation,
    signed: s,
  };
  // Persist identity before submitting, including when HTTP fails after the node accepted the bytes.
  await save(receipt);
  const r = await c.api("/cosmos/tx/v1beta1/txs", {
      tx_bytes: s.txRaw,
      mode: "BROADCAST_MODE_SYNC",
    }),
    t = r.tx_response;
  requireFact(
    t?.txhash?.toUpperCase() === txHash && t.code !== undefined,
    "BROADCAST_INVALID",
    "Unexpected broadcast response",
  );
  receipt.response = t;
  const resultCode = wireUint(t.code, 4294967295);
  receipt.status = resultCode === 0 ? "SUBMITTED" : "REJECTED";
  await save(receipt);
  requireFact(
    resultCode === 0,
    "TX_REJECTED",
    t.raw_log ?? "Mempool rejected transaction",
  );
  return receipt;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function confirm(
  c: Chain,
  txHash: string,
  fromHeight: string,
  timeoutMs = 120000,
  maxBlocks = 5000,
) {
  requireFact(
    /^[A-Fa-f0-9]{64}$/.test(txHash),
    "INVALID_HASH",
    "64-hex transaction hash required",
  );
  let height = integer(fromHeight, "from height", (1n << 64n) - 1n);
  requireFact(
    height > 0n,
    "INVALID_HEIGHT",
    "Positive starting height required",
  );
  const start = height,
    deadline = Date.now() + timeoutMs;
  requireFact(
    timeoutMs > 0 && timeoutMs <= 900000 && maxBlocks > 0 && maxBlocks <= 5000,
    "INVALID_LIMIT",
    "Confirmation limits invalid",
  );
  while (Date.now() < deadline) {
    const tip = BigInt(await c.tip());
    while (height <= tip && Date.now() < deadline) {
      requireFact(
        height - start < BigInt(maxBlocks),
        "SCAN_LIMIT",
        "Resume confirmation from next height; never resubmit automatically",
      );
      const b = (await c.rpc(`block?height=${height}`)).result;
      requireFact(
        b?.block?.header?.chain_id === c.deployment.chainId &&
          BigInt(b.block.header.height) === height,
        "WRONG_CHAIN",
        "Block identity differs",
      );
      const txs = b.block.data.txs ?? [];
      for (let i = 0; i < txs.length; i++)
        if (hash(fromBase64(txs[i])).toUpperCase() === txHash.toUpperCase()) {
          const results = (await c.rpc(`block_results?height=${height}`))
            .result;
          requireFact(
            BigInt(results.height) === height &&
              results.txs_results?.[i]?.code !== undefined,
            "INCOMPLETE",
            "Block result missing",
          );
          const result = results.txs_results[i];
          const resultCode = wireUint(result.code, 4294967295);
          return {
            status: resultCode === 0 ? "INCLUDED" : "FAILED",
            code: resultCode === 0 ? undefined : "TX_FAILED",
            txHash: txHash.toUpperCase(),
            height: height.toString(),
            index: i,
            blockId: b.block_id,
            result,
          };
        }
      height++;
    }
    await sleep(1500);
  }
  return {
    status: "INCOMPLETE",
    txHash,
    fromHeight,
    nextHeight: height.toString(),
    reason: "Confirmation timeout; continue same hash, do not resubmit",
  };
}
export async function reconcile(c: Chain, op: Operation) {
  const i = op.input,
    d = op.deployment;
  if (op.action === "create-offer") {
    const a = (
      await c.smart(d.factory, {
        deal_by_host_epoch: { host: op.sender, epoch: i.epoch },
      })
    ).address;
    const v = await c.deal(a);
    requireFact(
      v.config.price_micro_usdt_per_gnk === i.price &&
        v.config.buyer_budget_micro_usdt === i.budget,
      "POSTCONDITION_FAILED",
      "Offer terms differ",
    );
    return { status: "RESULT_VERIFIED", deal: a };
  }
  if (op.action === "route" || op.action === "remove-route") {
    const routes = await c.routes(op.sender);
    const selected = routes.find(
      (r) => Number(r.epoch) === op.terms.target_epoch,
    );
    requireFact(
      op.action === "route" ? selected?.recipient === i.deal : !selected,
      "POSTCONDITION_FAILED",
      "Routing not applied",
    );
    const other = op.terms.previousRoutes.filter(
      (r: any) => Number(r.epoch) !== op.terms.target_epoch,
    );
    for (const old of other)
      requireFact(
        routes.some(
          (r) => r.epoch === old.epoch && r.recipient === old.recipient,
        ),
        "POSTCONDITION_FAILED",
        "Unrelated routing changed (or pruned); inspect receipt",
      );
    return { status: "RESULT_VERIFIED", routes };
  }
  if (op.action === "claim") {
    requireFact(
      (await c.summary(op.terms.host, op.terms.target_epoch)).claimed,
      "POSTCONDITION_FAILED",
      "Claim not confirmed",
    );
    return { status: "RESULT_VERIFIED" };
  }
  const v = await c.deal(i.deal);
  const st = v.state;
  const valid =
    op.action === "fund"
      ? st.buyer === op.sender && st.status !== "open"
      : op.action === "lock"
        ? st.recipient_locked === true
        : op.action === "settle"
          ? ["releasing", "completed"].includes(st.status)
          : op.action === "withdraw"
            ? v.payments[i.role].pending_micro_usdt === "0"
            : op.action === "cancel"
              ? st.status === "cancelled"
              : op.action === "refund"
                ? ["refunded", "expired"].includes(st.status)
                : BigInt(st.released_total_ngonka) >
                  BigInt(op.terms.beforeState.released_total_ngonka);
  requireFact(
    valid,
    "POSTCONDITION_FAILED",
    "Expected state change not observed",
  );
  return { status: "RESULT_VERIFIED", state: st, payments: v.payments };
}

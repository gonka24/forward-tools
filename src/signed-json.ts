import { TxRaw, TxBody, AuthInfo } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { PubKey } from "cosmjs-types/cosmos/crypto/secp256k1/keys";
import { fromBase64, toBase64 } from "@cosmjs/encoding";
import { requireFact } from "./model.js";
import { encoded } from "./transactions.js";
export function signedJsonBytes(x: any): string {
  if (typeof x.tx_bytes === "string") return x.tx_bytes;
  // Cosmos CLI's JSON is converted to TxRaw with the same wire representation.
  const body = x.body,
    auth = x.auth_info;
  requireFact(
    !body?.unordered && !body?.timeout_timestamp && !auth?.tip,
    "SIGNED_TX_CHANGED",
    "Unordered transactions, timestamps and tips are not supported",
  );
  requireFact(
    body && auth && Array.isArray(x.signatures),
    "INVALID_SIGNED",
    "Expected Cosmos tx JSON or {tx_bytes: base64}",
  );
  requireFact(
    !body.extension_options?.length &&
      !body.non_critical_extension_options?.length,
    "SIGNED_TX_CHANGED",
    "Extensions not supported",
  );
  const raw = TxRaw.fromPartial({
    bodyBytes: TxBody.encode(
      TxBody.fromPartial({
        messages: body.messages.map((m: any) => {
          const { "@type": typeUrl, ...value } = m;
          return encoded({ typeUrl, value });
        }),
        memo: body.memo ?? "",
        timeoutHeight: BigInt(body.timeout_height ?? "0"),
      }),
    ).finish(),
    authInfoBytes: AuthInfo.encode(
      AuthInfo.fromPartial({
        signerInfos: auth.signer_infos.map((s: any) => {
          requireFact(
            s.public_key["@type"] === "/cosmos.crypto.secp256k1.PubKey" &&
              s.mode_info?.single?.mode === "SIGN_MODE_DIRECT",
            "UNSUPPORTED_SIGNER",
            "Direct secp256k1 signing only",
          );
          return {
            publicKey: {
              typeUrl: s.public_key["@type"],
              value: PubKey.encode({
                key: fromBase64(s.public_key.key),
              }).finish(),
            },
            modeInfo: { single: { mode: 1 } },
            sequence: BigInt(s.sequence),
          };
        }),
        fee: {
          amount: auth.fee.amount,
          gasLimit: BigInt(auth.fee.gas_limit),
          payer: auth.fee.payer ?? "",
          granter: auth.fee.granter ?? "",
        },
      }),
    ).finish(),
    signatures: x.signatures.map((s: string) => fromBase64(s)),
  });
  return toBase64(TxRaw.encode(raw).finish());
}

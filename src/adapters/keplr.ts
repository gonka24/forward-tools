import Long from "long";
import { fromBase64, toBase64 } from "@cosmjs/encoding";
import { TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { same } from "../chain.js";
import { ToolError, Unsigned, requireFact } from "../model.js";
import { EXEC } from "../operations.js";
import { CLAIM, ROUTE } from "../native.js";
import {
  SigningAdapter,
  pubAddress,
  validateUnsigned,
  verifySigned,
} from "../transactions.js";

/** Narrow injectable extension interface; importing the SDK never opens a wallet. */
export interface KeplrProvider {
  enable(chainId: string): Promise<void>;
  getKey(chainId: string): Promise<{
    algo: string;
    bech32Address: string;
    pubKey: Uint8Array;
    isNanoLedger?: boolean;
    isKeystone?: boolean;
  }>;
  signDirect(
    chainId: string,
    signer: string,
    signDoc: {
      bodyBytes: Uint8Array;
      authInfoBytes: Uint8Array;
      chainId: string;
      accountNumber: Long;
    },
    options: { preferNoSetFee: boolean; preferNoSetMemo: boolean },
  ): Promise<{
    signed: {
      bodyBytes: Uint8Array;
      authInfoBytes: Uint8Array;
      chainId: string;
      accountNumber: Long;
    };
    signature: { pub_key: { type: string; value: string }; signature: string };
  }>;
}

function walletError(error: unknown): never {
  if (error instanceof ToolError) throw error;
  const value = error as { code?: unknown; message?: unknown } | null;
  // Only an explicit rejection is a cancellation; generic extension failures remain errors.
  const rejected =
    value?.code === 4001 || value?.message === "Request rejected";
  throw new ToolError(
    rejected ? "WALLET_REJECTED" : "WALLET_FAILED",
    rejected ? "Wallet request declined by user" : "Wallet request failed",
  );
}

export class KeplrAdapter implements SigningAdapter {
  // Wire capabilities, not a claim of live compatibility with a Gonka deployment.
  readonly capabilities = { direct: true, typeUrls: [EXEC, ROUTE, CLAIM] };
  constructor(
    private readonly provider: KeplrProvider,
    readonly chainId: string,
  ) {
    requireFact(chainId.length > 0, "WRONG_CHAIN", "Chain ID required");
  }

  async connect(): Promise<{ address: string; publicKey: string }> {
    try {
      await this.provider.enable(this.chainId);
      const key = await this.provider.getKey(this.chainId);
      requireFact(
        key.algo === "secp256k1" && !key.isNanoLedger && !key.isKeystone,
        "WALLET_UNSUPPORTED",
        "This adapter requires a software secp256k1 direct signer",
      );
      const publicKey = toBase64(key.pubKey);
      requireFact(
        pubAddress(publicKey) === key.bech32Address,
        "SIGNER_MISMATCH",
        "Wallet address does not match its public key",
      );
      return { address: key.bech32Address, publicKey };
    } catch (error) {
      walletError(error);
    }
  }

  async getAddress(): Promise<string> {
    return (await this.connect()).address;
  }

  /** Sign only. Use ForwardClient.sign for fresh chain checks before opening Keplr. */
  async sign(unsigned: Unsigned): Promise<string> {
    // Snapshot before the first await: callers and extensions cannot replace reviewed intent.
    const u: Unsigned = structuredClone(unsigned);
    const raw = validateUnsigned(u);
    requireFact(
      u.operation.test_fixture_only !== true,
      "TEST_FIXTURE",
      "Example packages cannot authorize signing",
    );
    requireFact(
      u.operation.deployment.chainId === this.chainId,
      "WRONG_CHAIN",
      "Wallet chain differs from prepared operation",
    );
    requireFact(
      u.operation.messages.every((m) =>
        this.capabilities.typeUrls.includes(m.typeUrl),
      ),
      "WALLET_UNSUPPORTED",
      "Unsupported message type",
    );
    const key = await this.connect();
    requireFact(
      key.address === u.operation.sender && key.publicKey === u.publicKey,
      "SIGNER_MISMATCH",
      "Selected wallet differs from prepared signer",
    );
    const expected = {
      bodyBytes: toBase64(raw.bodyBytes),
      authInfoBytes: toBase64(raw.authInfoBytes),
      chainId: this.chainId,
      accountNumber: u.accountNumber,
    };
    let response: Awaited<ReturnType<KeplrProvider["signDirect"]>>;
    try {
      response = await this.provider.signDirect(
        this.chainId,
        u.operation.sender,
        {
          bodyBytes: raw.bodyBytes.slice(),
          authInfoBytes: raw.authInfoBytes.slice(),
          chainId: this.chainId,
          // Keplr uses Long; the core uses bigint. Never convert through Number.
          accountNumber: Long.fromString(u.accountNumber, true),
        },
        { preferNoSetFee: true, preferNoSetMemo: true },
      );
    } catch (error) {
      walletError(error);
    }
    requireFact(
      response?.signed?.bodyBytes instanceof Uint8Array &&
        response.signed.authInfoBytes instanceof Uint8Array &&
        typeof response.signed.chainId === "string" &&
        Long.isLong(response.signed.accountNumber) &&
        typeof response.signature?.signature === "string" &&
        typeof response.signature.pub_key?.value === "string",
      "WALLET_INVALID_RESPONSE",
      "Wallet returned a malformed direct signing response",
    );
    requireFact(
      same(expected, {
        bodyBytes: toBase64(response.signed.bodyBytes),
        authInfoBytes: toBase64(response.signed.authInfoBytes),
        chainId: response.signed.chainId,
        accountNumber: response.signed.accountNumber.toString(),
      }) &&
        response.signature.pub_key.type === "tendermint/PubKeySecp256k1" &&
        response.signature.pub_key.value === u.publicKey,
      "SIGNED_TX_CHANGED",
      "Wallet changed the reviewed signing document or public key",
    );
    raw.signatures = [fromBase64(response.signature.signature)];
    const txRaw = toBase64(TxRaw.encode(raw).finish());
    await verifySigned(u, txRaw);
    return txRaw;
  }
}

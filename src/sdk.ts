import { Chain, same } from "./chain.js";
import {
  Operation,
  Signed,
  Unsigned,
  ToolError,
  requireFact,
} from "./model.js";
import { prepare } from "./operations.js";
import {
  SigningAdapter,
  exportTx,
  validateUnsigned,
  checkFresh,
  verifySigned,
  broadcast,
  confirmReceipt,
} from "./transactions.js";

/** Amounts are canonical integer micro-USDT strings, never display decimals. */
export interface ActionInputs {
  "create-offer": { epoch: number; price: string; budget: string };
  route: { deal: string };
  "remove-route": { deal: string };
  fund: { deal: string };
  lock: { deal: string };
  claim: { deal: string; seed: string };
  settle: { deal: string };
  withdraw: { deal: string; role: "host" | "fee" | "buyer" };
  release: { deal: string };
  refund: { deal: string; emergency?: boolean };
  cancel: { deal: string };
  "forward-excess": { deal: string };
}
export type PrepareRequest = {
  [A in keyof ActionInputs]: {
    action: A;
    sender: string;
    input: ActionInputs[A];
  };
}[keyof ActionInputs];
export interface ExportOptions {
  publicKey?: string;
  maxFee?: string;
  claimGas?: string;
}
export interface SdkError {
  code: string;
  message: string;
}
export interface BroadcastReceipt {
  schema: "gonka24/forward-broadcast/1";
  status: "SUBMISSION_UNKNOWN" | "SUBMITTED" | "REJECTED";
  txHash: string;
  fromHeight: string;
  operation: Operation;
  signed: Signed;
  response?: unknown;
  reason?: string;
}
export type SubmissionOutcome = {
  [S in BroadcastReceipt["status"]]: {
    status: S;
    receipt: BroadcastReceipt & { status: S };
    error?: SdkError;
  };
}[BroadcastReceipt["status"]];
export type Postcondition =
  | {
      status: "RESULT_VERIFIED";
      deal?: string;
      state?: unknown;
      payments?: unknown;
      routes?: unknown;
    }
  | { status: "UNVERIFIED"; code: string; message: string };
type ConfirmationBase = Omit<BroadcastReceipt, "status"> & {
  scanFromHeight: string;
};
export type ConfirmationReceipt = ConfirmationBase &
  (
    | { status: "INCLUDED"; height: string; postcondition: Postcondition }
    | { status: "FAILED"; height: string; code: string }
    | { status: "INCOMPLETE"; nextHeight: string; code: string; reason: string }
  );
export interface SubmitOptions {
  /** Explicit approval of this submission, separate from authorization to sign. */
  approved: true;
  /** Resolve only after durable storage; invoked before any submission HTTP request. */
  saveReceipt: (receipt: BroadcastReceipt) => Promise<void>;
}
const copy = <T>(value: T): T => structuredClone(value);
const sdkError = (error: unknown): SdkError => ({
  code: error instanceof ToolError ? error.code : "UNEXPECTED",
  message: error instanceof Error ? error.message : String(error),
});

/** Shared transaction lifecycle for browser owners and external keeper signers. */
export class ForwardClient {
  constructor(public readonly chain: Chain) {}

  prepare(request: PrepareRequest): Promise<Operation> {
    const r = copy(request);
    return prepare(this.chain, r.action, r.sender, r.input);
  }

  exportTx(
    operation: Operation,
    options: ExportOptions = {},
  ): Promise<Unsigned> {
    const o = copy(options);
    return exportTx(
      this.chain,
      copy(operation),
      o.publicKey,
      o.maxFee,
      o.claimGas,
    );
  }

  async sign(unsigned: Unsigned, adapter: SigningAdapter): Promise<Signed> {
    // Retain a private reviewed snapshot across every asynchronous wallet call.
    const reviewed = copy(unsigned);
    validateUnsigned(reviewed);
    requireFact(
      same(reviewed.operation.deployment, this.chain.deployment),
      "DEPLOYMENT_MISMATCH",
      "Signing deployment differs",
    );
    requireFact(
      adapter.capabilities.direct &&
        reviewed.operation.messages.every((m) =>
          adapter.capabilities.typeUrls.includes(m.typeUrl),
        ),
      "UNSUPPORTED_SIGNER",
      "Signer must support direct signing and every message type",
    );
    requireFact(
      (await adapter.getAddress()) === reviewed.operation.sender,
      "SIGNER_MISMATCH",
      "Selected signer differs from operation sender",
    );
    await checkFresh(this.chain, reviewed);
    // The signer receives another copy: it cannot rewrite the verification reference.
    const raw = await adapter.sign(copy(reviewed));
    return verifySigned(reviewed, raw);
  }

  async submit(
    signed: Signed,
    options: SubmitOptions,
  ): Promise<SubmissionOutcome> {
    requireFact(
      options?.approved === true && typeof options.saveReceipt === "function",
      "SUBMISSION_NOT_APPROVED",
      "Explicit submission approval and durable receipt storage required",
    );
    let durable: BroadcastReceipt | undefined;
    try {
      await broadcast(
        this.chain,
        copy(signed),
        async (receipt: BroadcastReceipt) => {
          const snapshot = copy(receipt);
          await options.saveReceipt(copy(snapshot));
          durable = snapshot;
        },
      );
    } catch (error) {
      // Once a receipt exists, an exception may follow accepted bytes. Preserve the
      // same hash for recovery; never turn transport failure into permission to retry.
      if (durable)
        return {
          status: durable.status,
          receipt: durable,
          error: sdkError(error),
        } as SubmissionOutcome;
      throw error;
    }
    requireFact(durable, "INCOMPLETE", "Submission did not persist a receipt");
    return { status: durable.status, receipt: durable } as SubmissionOutcome;
  }

  async confirm(
    receipt: BroadcastReceipt | ConfirmationReceipt,
    options: { timeoutMs?: number; maxBlocks?: number } = {},
  ): Promise<ConfirmationReceipt> {
    const result = await confirmReceipt(
      this.chain,
      copy(receipt),
      options.timeoutMs,
      options.maxBlocks,
    );
    requireFact(
      ["INCLUDED", "FAILED", "INCOMPLETE"].includes(result.status),
      "INCOMPLETE",
      "Unknown confirmation result",
    );
    return result as ConfirmationReceipt;
  }
}

export class ToolError extends Error {
  constructor(
    public code: string,
    message: string,
    public exitCode = 1,
  ) {
    super(message);
  }
}
export function requireFact(
  condition: unknown,
  code: string,
  message: string,
): asserts condition {
  if (!condition) throw new ToolError(code, message);
}
export type Json = any;
export type Action =
  | "create-offer"
  | "route"
  | "remove-route"
  | "fund"
  | "lock"
  | "claim"
  | "settle"
  | "withdraw"
  | "release"
  | "refund"
  | "cancel"
  | "forward-excess";
export interface Deployment {
  id: string;
  chainId: string;
  nodes: string[];
  gonkaSha: string;
  contractsSha: string;
  factory: string;
  factoryCodeId: number;
  dealCodeId: number;
  token: string;
  feeRecipient: string;
  factoryHash: string;
  dealHash: string;
  tokenHash: string;
  feeBps: number;
  protoSha: string;
  evidence: string;
}
export interface Message {
  typeUrl: string;
  value: Json;
}
export interface Operation {
  schema: "gonka24/forward-operation/1";
  deployment: Deployment;
  sender: string;
  action: Action;
  input: Json;
  messages: Message[];
  terms: Json;
  checkedAt: string;
  checkedHeight: string;
}
export interface Unsigned {
  schema: "gonka24/forward-unsigned/1";
  operation: Operation;
  tx: Json;
  accountNumber: string;
  sequence: string;
  publicKey: string;
  gas: string;
  fee: string;
  signDoc?: {
    bodyBytes: string;
    authInfoBytes: string;
    chainId: string;
    accountNumber: string;
  };
}
export interface Signed {
  schema: "gonka24/forward-signed/1";
  unsigned: Unsigned;
  txRaw: string;
}
export const ACTIONS: Action[] = [
  "create-offer",
  "route",
  "remove-route",
  "fund",
  "lock",
  "claim",
  "settle",
  "withdraw",
  "release",
  "refund",
  "cancel",
  "forward-excess",
];
export function integer(
  value: unknown,
  name: string,
  max = (1n << 128n) - 1n,
): bigint {
  requireFact(
    typeof value === "string" && /^(0|[1-9]\d*)$/.test(value),
    "INVALID_AMOUNT",
    `${name}: expected canonical integer string`,
  );
  const n = BigInt(value);
  requireFact(n <= max, "INVALID_AMOUNT", `${name}: overflow`);
  return n;
}
export function epoch(value: unknown): number {
  requireFact(
    Number.isSafeInteger(value) && Number(value) >= 0,
    "INVALID_EPOCH",
    "Epoch must be a safe nonnegative integer",
  );
  return Number(value);
}
export function signed64(value: unknown): string {
  requireFact(
    typeof value === "string" && /^(0|-?[1-9]\d*)$/.test(value),
    "INVALID_SEED",
    "Claim seed must be a canonical signed int64",
  );
  const n = BigInt(value);
  requireFact(
    n >= -(1n << 63n) && n < 1n << 63n,
    "INVALID_SEED",
    "Claim seed overflows int64",
  );
  return value;
}
export function decimal(value: string, decimals = 6): string {
  requireFact(
    new RegExp(`^(0|[1-9]\\d*)(?:\\.\\d{1,${decimals}})?$`).test(value),
    "INVALID_AMOUNT",
    "Invalid decimal amount",
  );
  const [a, b = ""] = value.split(".");
  return integer(
    (a + b.padEnd(decimals, "0")).replace(/^0+(?=\d)/, ""),
    "amount",
  ).toString();
}
export function economics(budget: string, price: string, total?: string) {
  const D = integer(budget, "budget"),
    P = integer(price, "price");
  requireFact(
    D > 0n && P > 0n,
    "INVALID_AMOUNT",
    "Budget and price must be positive",
  );
  const capacity = (D * 1000000000n) / P;
  requireFact(
    capacity > 0n && capacity < 1n << 128n,
    "INVALID_AMOUNT",
    "Capacity is zero or overflows",
  );
  const B =
      total === undefined
        ? capacity
        : integer(total, "total") < capacity
          ? integer(total, "total")
          : capacity,
    gross = (B * P) / 1000000000n,
    fee = (gross * 150n) / 10000n;
  return {
    capacityNgonka: capacity.toString(),
    grossMicroUsdt: gross.toString(),
    feeMicroUsdt: fee.toString(),
    hostNetMicroUsdt: (gross - fee).toString(),
    buyerRefundMicroUsdt: (D - gross).toString(),
    feeBps: 150,
  };
}

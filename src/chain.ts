import { sha256 } from "@cosmjs/crypto";
import {
  fromBech32,
  fromBase64,
  toBase64,
  toUtf8,
  toHex,
} from "@cosmjs/encoding";
import {
  Deployment,
  ToolError,
  requireFact,
  epoch,
  integer,
  wireUint,
  UINT64_MAX,
} from "./model.js";
export const NATIVE = "/productscience/inference/inference/";
export type Fetcher = (url: string, init?: RequestInit) => Promise<any>;
export const http: Fetcher = async (url, init) => {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
    const body = await r.json();
    if (!r.ok || body.error || (body.code && body.message))
      throw new ToolError(
        "RPC_ERROR",
        `RPC ${r.status}: ${body.message ?? JSON.stringify(body.error)}`,
      );
    return body;
  } catch (e) {
    if (e instanceof ToolError) throw e;
    throw new ToolError(
      "RPC_UNAVAILABLE",
      `RPC request failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
};
export function address(a: string) {
  try {
    const d = fromBech32(a, 128);
    requireFact(
      d.prefix === "gonka" && [20, 32].includes(d.data.length),
      "INVALID_ADDRESS",
      "Expected Gonka address",
    );
  } catch {
    throw new ToolError("INVALID_ADDRESS", "Invalid Gonka bech32 address");
  }
  return a;
}
export function hash(b: Uint8Array) {
  return toHex(sha256(b));
}
const HEX40 = /^[0-9a-f]{40}$/,
  HEX64 = /^[0-9a-f]{64}$/;
function nodeUrl(value: unknown) {
  if (typeof value !== "string" || value.endsWith("/")) return false;
  try {
    const u = new URL(value);
    return (
      ["https:", "http:"].includes(u.protocol) &&
      u.username === "" &&
      u.password === "" &&
      u.search === "" &&
      u.hash === ""
    );
  } catch {
    return false;
  }
}
/**
 * A deployment document pins every identity that later checks compare against.
 * Reject incomplete documents up front: an empty node list would otherwise make
 * verification vacuously succeed, and malformed pins would only fail later and less clearly.
 */
export function validateDeployment(d: any): Deployment {
  const field = (ok: unknown, name: string) =>
    requireFact(
      ok,
      "INVALID_DEPLOYMENT",
      `Deployment ${name} missing or malformed`,
    );
  field(d && typeof d === "object" && !Array.isArray(d), "document");
  field(typeof d.id === "string" && /^[A-Za-z0-9-]+$/.test(d.id), "id");
  field(typeof d.chainId === "string" && d.chainId.length > 0, "chainId");
  field(
    Array.isArray(d.nodes) && d.nodes.length > 0 && d.nodes.every(nodeUrl),
    "nodes",
  );
  for (const k of ["gonkaSha", "contractsSha", "protoSha"])
    field(typeof d[k] === "string" && HEX40.test(d[k]), k);
  for (const k of ["factoryHash", "dealHash", "tokenHash"])
    field(typeof d[k] === "string" && HEX64.test(d[k]), k);
  for (const k of ["factoryCodeId", "dealCodeId"])
    field(Number.isSafeInteger(d[k]) && d[k] > 0, k);
  field(
    Number.isSafeInteger(d.feeBps) && d.feeBps >= 0 && d.feeBps <= 10000,
    "feeBps",
  );
  for (const k of ["factory", "token", "feeRecipient"]) {
    let valid = false;
    try {
      // Chain responses are lowercase; an uppercase pin could never match them.
      valid = address(d[k]) === d[k].toLowerCase();
    } catch {}
    field(valid, k);
  }
  field(typeof d.evidence === "string", "evidence");
  return d;
}
export function same(a: any, b: any) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
function canonical(x: any): any {
  return Array.isArray(x)
    ? x.map(canonical)
    : x && typeof x === "object"
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, canonical(x[k])]),
        )
      : x;
}
export interface ChainOptions {
  /** Skip only runtime commit equality. Other deployment checks still apply. */
  assumeRuntimeCompatible?: boolean;
}
export class Chain {
  constructor(
    public deployment: Deployment,
    public fetcher: Fetcher = http,
    public base = deployment.nodes[0],
    public options: ChainOptions = {},
  ) {}
  api(path: string, body?: any) {
    return this.fetcher(
      `${this.base}/chain-api${path}`,
      body
        ? {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }
        : undefined,
    );
  }
  rpc(path: string, body?: any) {
    return this.fetcher(
      `${this.base}/chain-rpc/${path}`,
      body
        ? {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }
        : undefined,
    );
  }
  async tip() {
    const r = (await this.rpc("status")).result;
    requireFact(
      r?.node_info?.network === this.deployment.chainId,
      "WRONG_CHAIN",
      "RPC chain ID differs",
    );
    requireFact(
      r.sync_info.catching_up === false,
      "STALE_RPC",
      "RPC catching up",
    );
    const age = Date.now() - Date.parse(r.sync_info.latest_block_time);
    requireFact(
      Number.isFinite(age) && Math.abs(age) < 180000,
      "STALE_RPC",
      "RPC tip stale",
    );
    integer(r.sync_info.latest_block_height, "height", UINT64_MAX);
    return r.sync_info.latest_block_height as string;
  }
  async smart(a: string, msg: any) {
    return (
      await this.api(
        `/cosmwasm/wasm/v1/contract/${address(a)}/smart/${encodeURIComponent(toBase64(toUtf8(JSON.stringify(msg))))}`,
      )
    ).data;
  }
  async info(a: string) {
    const r = await this.api(`/cosmwasm/wasm/v1/contract/${address(a)}`);
    requireFact(
      r.address === a,
      "IDENTITY_MISMATCH",
      "Contract identity differs",
    );
    return r.contract_info;
  }
  async code(id: number, expected: string) {
    const r = await this.api(`/cosmwasm/wasm/v1/code/${id}`);
    requireFact(
      hash(fromBase64(r.data)) === expected &&
        r.code_info.data_hash.toLowerCase() === expected,
      "CODE_MISMATCH",
      `Code ${id} checksum differs`,
    );
    return r.code_info;
  }
  async verify() {
    const d = validateDeployment(this.deployment);
    const assumeRuntimeCompatible =
      this.options.assumeRuntimeCompatible ??
      (typeof process !== "undefined" &&
        process.env?.GONKA_FORWARD_ASSUME_RUNTIME_COMPATIBLE === "true");
    const receipts = [];
    for (const node of d.nodes) {
      const c = new Chain(d, this.fetcher, node),
        height = await c.tip();
      const app = (await c.api("/cosmos/base/tendermint/v1beta1/node_info"))
        .application_version;
      requireFact(
        assumeRuntimeCompatible || app.git_commit === d.gonkaSha,
        "RUNTIME_CHANGED",
        "Gonka runtime differs from validated version",
      );
      const f = await c.info(d.factory);
      requireFact(
        Number(f.code_id) === d.factoryCodeId && f.admin === "",
        "FACTORY_MISMATCH",
        "Factory code/admin differs",
      );
      requireFact(
        same(await c.smart(d.factory, { config: {} }), {
          deal_code_id: d.dealCodeId,
          settlement_cw20: d.token,
          fee_recipient: d.feeRecipient,
          fee_bps: d.feeBps,
        }),
        "CONFIG_MISMATCH",
        "Factory config differs",
      );
      await c.code(d.factoryCodeId, d.factoryHash);
      const deal = await c.code(d.dealCodeId, d.dealHash);
      requireFact(
        deal.instantiate_permission?.permission === "Everybody",
        "INSTANTIATE_BLOCKED",
        "Deal instantiation permission differs",
      );
      const token = await c.info(d.token);
      await c.code(Number(token.code_id), d.tokenHash);
      const meta = await c.smart(d.token, { token_info: {} });
      requireFact(
        meta.symbol === "USDT" && meta.decimals === 6,
        "TOKEN_MISMATCH",
        "Token metadata differs",
      );
      requireFact(
        same(await c.smart(d.token, { bridge_info: {} }), {
          chain_id: "ethereum",
          contract_address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
        }),
        "TOKEN_MISMATCH",
        "Bridge origin differs",
      );
      receipts.push({
        node,
        height,
        gonkaSha: app.git_commit,
        runtimeCompatibility: assumeRuntimeCompatible ? "ASSUMED" : "MATCHED",
      });
    }
    return { status: "VERIFIED", deployment: d.id, observations: receipts };
  }
  async currentEpoch() {
    return epoch(
      wireUint((await this.api(NATIVE + "get_current_epoch")).epoch),
    );
  }
  async routes(host: string) {
    const r = await this.api(NATIVE + `list_claim_recipients/${address(host)}`);
    requireFact(
      Array.isArray(r.entries),
      "INCOMPLETE",
      "Routing response missing entries",
    );
    const seen = new Set<number>();
    for (const e of r.entries) {
      const n = epoch(wireUint(e.epoch));
      requireFact(!seen.has(n), "ROUTING_INVALID", "Duplicate routing epoch");
      seen.add(n);
      requireFact(
        typeof e.recipient === "string" && e.recipient.length > 0,
        "INCOMPLETE",
        "Stored routing recipient missing",
      );
      address(e.recipient);
    }
    return r.entries as { epoch: string; recipient: string }[];
  }
  async host(host: string) {
    const p = (await this.api(NATIVE + `participant/${address(host)}`))
      .participant;
    requireFact(
      p?.index === host || p?.address === host,
      "HOST_MISMATCH",
      "Participant identity missing or mismatched",
    );
    requireFact(
      p.status === "ACTIVE",
      "HOST_NOT_COMPUTE_PARTICIPANT",
      "Participant is not currently active",
    );
    // weight is a legacy sentinel (-1 even for live compute hosts in this runtime).
    // An ordinary developer row is distinguished by registered hardware, not weight.
    const hardware = (await this.api(NATIVE + `hardware_nodes/${host}`)).nodes;
    requireFact(
      hardware?.participant === host &&
        Array.isArray(hardware.hardware_nodes) &&
        hardware.hardware_nodes.some(
          (n: any) =>
            typeof n.host === "string" &&
            n.host.length > 0 &&
            Array.isArray(n.models) &&
            n.models.length > 0,
        ),
      "HOST_COMPUTE_UNVERIFIED",
      "Registered compute hardware for this participant was not established",
    );
    p.hardware = hardware;
    return p;
  }
  async balance(a: string) {
    const r = await this.api(
      `/cosmos/bank/v1beta1/balances/${address(a)}/by_denom?denom=ngonka`,
    );
    return integer(r.balance?.amount, "GNK balance").toString();
  }
  async account(a: string) {
    const r = (await this.api(`/cosmos/auth/v1beta1/accounts/${address(a)}`))
      .account;
    requireFact(
      r?.["@type"] === "/cosmos.auth.v1beta1.BaseAccount" && r.address === a,
      "UNSUPPORTED_ACCOUNT",
      "Only direct secp256k1 BaseAccount supported by this transaction exporter",
    );
    integer(r.account_number, "account number", UINT64_MAX);
    integer(r.sequence, "sequence", UINT64_MAX);
    return r;
  }
  async summary(host: string, E: number) {
    const s = (
      await this.api(NATIVE + `epoch_performance_summary/${E}/${address(host)}`)
    ).epochPerformanceSummary;
    requireFact(
      s &&
        Number(s.epoch_index) === E &&
        s.participant_id === host &&
        typeof s.claimed === "boolean",
      "SUMMARY_INVALID",
      "Claim summary identity or shape differs",
    );
    integer(s.earned_coins, "earned coins", UINT64_MAX);
    integer(s.rewarded_coins, "reward coins", UINT64_MAX);
    return s;
  }
  async deal(a: string) {
    const d = this.deployment,
      info = await this.info(a),
      config = await this.smart(a, { config: {} });
    requireFact(
      Number(info.code_id) === d.dealCodeId &&
        info.admin === "" &&
        info.creator === d.factory,
      "DEAL_MISMATCH",
      "Deal code/admin/creator differs",
    );
    requireFact(
      config.factory === d.factory &&
        config.deal_address === a &&
        config.settlement_cw20 === d.token &&
        config.fee_recipient === d.feeRecipient &&
        config.fee_bps === 150 &&
        config.pinned_gonka_sha === d.protoSha,
      "DEAL_MISMATCH",
      "Deal terms/protobuf pin differs",
    );
    // Callers derive windows such as E + 5; a non-numeric epoch must not concatenate.
    epoch(config.target_epoch);
    requireFact(
      (
        await this.smart(d.factory, {
          deal_by_host_epoch: { host: config.host, epoch: config.target_epoch },
        })
      ).address === a,
      "DEAL_UNREGISTERED",
      "Deal not registered in selected Factory",
    );
    const state = await this.smart(a, { state: {} }),
      payments = await this.smart(a, { usdt_payments: {} });
    requireFact(
      [
        "open",
        "funded",
        "locked",
        "releasing",
        "completed",
        "refunded",
        "cancelled",
        "expired",
      ].includes(state.status),
      "STATE_INVALID",
      "Unknown Deal state",
    );
    return { config, state, payments };
  }
}

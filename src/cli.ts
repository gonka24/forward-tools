#!/usr/bin/env node
import { signedJsonBytes } from "./signed-json.js";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { Chain, address, same, validateDeployment } from "./chain.js";
import {
  ToolError,
  requireFact,
  decimal,
  Deployment,
  Signed,
} from "./model.js";
import { prepare, status } from "./operations.js";
import {
  exportTx,
  verifySigned,
  checkFresh,
  broadcast,
  confirmReceipt,
} from "./transactions.js";
import { InferencedAdapter } from "./adapters/inferenced.js";
import { readiness } from "./readiness.js";
import { updateReceipt } from "./files.js";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2),
  group = args.shift(),
  command = group === "doctor" ? undefined : args.shift(),
  argv = args;
const opts: Record<string, string | boolean> = {};
function parse() {
  for (let i = 0; i < argv.length; i++) {
    requireFact(argv[i].startsWith("--"), "USAGE", "Use --named options");
    const k = argv[i].slice(2);
    requireFact(!(k in opts), "USAGE", `Duplicate --${k}`);
    opts[k] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  }
}
function str(k: string, required = true): string | undefined {
  const v = opts[k];
  requireFact(
    (v === undefined && !required) || typeof v === "string",
    "USAGE",
    `--${k} requires a value`,
  );
  return v as string | undefined;
}
/** Exact decimal integer: no hex, exponent, sign, fraction or whitespace (Number() accepts all). */
function whole(k: string, min: number, max: number): number | undefined {
  const v = str(k, false);
  if (v === undefined) return undefined;
  requireFact(
    /^(0|[1-9]\d*)$/.test(v) && Number(v) >= min && Number(v) <= max,
    "USAGE",
    `--${k} must be a decimal integer from ${min} to ${max}`,
  );
  return Number(v);
}
async function load(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}
/** Outputs are evidence: never overwrite one, and refuse before doing any network or signing work. */
async function absent(path: string) {
  try {
    await access(path);
  } catch (e: any) {
    if (e?.code === "ENOENT") return;
    throw e;
  }
  throw new ToolError(
    "OUTPUT_EXISTS",
    `${path} already exists; choose a new file`,
    2,
  );
}
async function save(path: string, value: any) {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
}
function print(value: any) {
  console.log(JSON.stringify(value, null, 2));
}
function help() {
  console.log(`forward-tools 0.1.0 — wallet-independent Gonka operations
doctor --deployment mainnet-v1
deployment verify --deployment mainnet-v1
host check --host ADDRESS [--signer ADDRESS] [--out REPORT]
deal prepare --action ACTION --sender ADDRESS [--deal ADDRESS] [--epoch N --price USDT_PER_GNK --budget USDT] [--role host|fee|buyer] [--seed INTEGER] [--emergency] --out OPERATION
deal status --deal ADDRESS
tx export --operation FILE [--public-key BASE64] [--max-fee NGONKA] [--claim-gas EXPLICIT_LIMIT] --out UNSIGNED
tx sign --unsigned FILE --adapter inferenced --cli PATH --key NAME --home DIR --backend os|file --out SIGNED
tx import --unsigned FILE --signed-tx FILE --out SIGNED
tx broadcast --signed FILE --receipt FILE --confirm
tx confirm --receipt FILE [--timeout-seconds 1..900, default 120] [--out RESULT]
report readiness --host ADDRESS [--signer ADDRESS] [--epoch N --price DECIMAL --budget DECIMAL] [--signing-proofs FILE1,FILE2,FILE3] --out REPORT
All commands support --deployment ID and emit JSON. Local outputs are excluded from Git when stored in .forward/.
Output files (--out, broadcast --receipt) are never overwritten; choose a new name for each result.
--deployment-file FILE is for explicitly configured local validation networks.
Actions: create-offer route remove-route fund lock claim settle withdraw release refund cancel forward-excess
Private keys/seeds/passwords are never inputs to tools. --seed is the public claim seed already committed by the participant, not a wallet seed phrase.`);
}
async function consent(label: string) {
  requireFact(
    process.stdin.isTTY,
    "OWNER_CONFIRMATION",
    "Run signing/submission in owner interactive terminal",
  );
  const r = createInterface({ input: process.stdin, output: process.stderr });
  try {
    requireFact(
      (await r.question(`${label}. Type CONFIRM: `)) === "CONFIRM",
      "OWNER_DECLINED",
      "Action declined",
    );
  } finally {
    r.close();
  }
}
async function signedBytes(file: string) {
  return signedJsonBytes(await load(file));
}
async function loadDeployment(): Promise<Deployment> {
  const file = str("deployment-file", false),
    id = str("deployment", false);
  requireFact(
    file === undefined || id === undefined,
    "USAGE",
    "Use either --deployment or --deployment-file",
  );
  if (file !== undefined) return validateDeployment(await load(file));
  const name = id ?? "mainnet-v1";
  // A registry ID is a plain name; a path here would load an arbitrary file as a pinned entry.
  requireFact(
    /^[A-Za-z0-9-]+$/.test(name),
    "USAGE",
    "--deployment must be a registry ID such as mainnet-v1",
  );
  let d: Deployment;
  try {
    d = await load(join(root, "deployments", `${name}.json`));
  } catch (e: any) {
    if (e?.code === "ENOENT")
      throw new ToolError("USAGE", `Unknown deployment ${name}`);
    throw e;
  }
  validateDeployment(d);
  requireFact(
    d.id === name,
    "INVALID_DEPLOYMENT",
    "Registry entry ID differs from its file name",
  );
  return d;
}

async function main() {
  if (!group || group === "help" || group === "--help") {
    help();
    return;
  }
  parse();
  const allowed = new Set([
    "deployment",
    "deployment-file",
    "json",
    "host",
    "signer",
    "out",
    "deal",
    "action",
    "sender",
    "epoch",
    "price",
    "budget",
    "role",
    "seed",
    "emergency",
    "operation",
    "public-key",
    "max-fee",
    "claim-gas",
    "unsigned",
    "adapter",
    "cli",
    "key",
    "home",
    "backend",
    "signed-tx",
    "signed",
    "receipt",
    "confirm",
    "timeout-seconds",
    "signing-proofs",
  ]);
  for (const [k, v] of Object.entries(opts)) {
    requireFact(allowed.has(k), "USAGE", `Unknown --${k}`);
    if (["json", "emergency", "confirm"].includes(k))
      requireFact(v === true, "USAGE", `--${k} is a standalone flag`);
  }
  const out = str("out", false);
  if (out !== undefined) await absent(out);
  const deployment = await loadDeployment();
  const c = new Chain(deployment);
  let result: any;
  if (group === "doctor") {
    const [major, minor] = process.versions.node.split(".").map(Number);
    requireFact(
      major === 24 && minor >= 13,
      "NODE_VERSION",
      "Node.js 24 LTS (24.13 or newer) required",
    );
    result = {
      status: "ENVIRONMENT_READY",
      node: process.versions.node,
      chainHeight: await c.tip(),
      signing: "NOT_CHECKED",
    };
  } else if (group === "deployment" && command === "verify")
    result = await c.verify();
  else if (group === "host" && command === "check") {
    const host = str("host")!,
      signer = str("signer", false);
    if (signer !== undefined) address(signer);
    await c.verify();
    result = {
      status: "HOST_CHECKED",
      host,
      participant: await c.host(host),
      routes: await c.routes(host),
      balanceNgonka: await c.balance(host),
      signer: signer ?? null,
      // An unnamed signer is unknown, not evidence of routing authority.
      signerCanRoute: signer === undefined ? null : signer === host,
      note: "Routing requires participant owner; warm-key claim authz not implemented in v1",
    };
  } else if (group === "deal" && command === "status")
    result = await status(c, str("deal")!);
  else if (group === "deal" && command === "prepare") {
    const action = str("action")!,
      sender = str("sender")!;
    requireFact(out !== undefined, "USAGE", "--out required");
    const input: any = {};
    for (const k of ["deal", "role", "seed"])
      if (str(k, false) !== undefined) input[k] = str(k);
    const E = whole("epoch", 0, Number.MAX_SAFE_INTEGER);
    if (E !== undefined) input.epoch = E;
    if (opts.price !== undefined) input.price = decimal(str("price")!);
    if (opts.budget !== undefined) input.budget = decimal(str("budget")!);
    if (opts.emergency === true) input.emergency = true;
    result = await prepare(c, action as any, sender, input);
  } else if (group === "tx" && command === "export") {
    const operation = str("operation")!;
    requireFact(out !== undefined, "USAGE", "--out required");
    result = await exportTx(
      c,
      await load(operation),
      str("public-key", false),
      str("max-fee", false),
      str("claim-gas", false),
    );
  } else if (group === "tx" && command === "sign") {
    requireFact(
      str("adapter") === "inferenced",
      "UNSUPPORTED_ADAPTER",
      "Use tx export/import for external signers",
    );
    requireFact(out !== undefined, "USAGE", "--out required");
    // Every signing argument is checked before the owner is asked to confirm.
    const adapter = new InferencedAdapter(
      str("cli")!,
      str("key")!,
      str("home")!,
      str("backend")!,
    );
    const u = await load(str("unsigned")!);
    await checkFresh(c, u);
    console.error(
      JSON.stringify(
        {
          operation: u.operation,
          feeNgonka: u.fee,
          gas: u.gas,
          gasReview: u.gasReview,
        },
        null,
        2,
      ),
    );
    await consent("Owner authorizes signature only");
    const folder = dirname(resolve(out));
    await mkdir(folder, { recursive: true });
    const txPath = join(folder, `unsigned-${Date.now()}.local.json`),
      signedPath = join(folder, `signed-${Date.now()}.local.json`);
    await save(txPath, u.tx);
    const raw = await adapter.sign(u, {
      unsignedTx: txPath,
      signedTx: signedPath,
    });
    result = await verifySigned(u, raw);
  } else if (group === "tx" && command === "import") {
    const signedTx = str("signed-tx")!;
    const u = await load(str("unsigned")!);
    await checkFresh(c, u);
    result = await verifySigned(u, await signedBytes(signedTx));
  } else if (group === "tx" && command === "broadcast") {
    requireFact(
      opts.confirm === true,
      "OWNER_CONFIRMATION",
      "--confirm required for explicit submission",
    );
    const p = str("receipt")!;
    await absent(p);
    const s: Signed = await load(str("signed")!);
    requireFact(
      s?.schema === "gonka24/forward-signed/1" && s.unsigned?.operation,
      "INVALID_SIGNED",
      "Wrong signed envelope",
    );
    requireFact(
      same(s.unsigned.operation.deployment, deployment),
      "DEPLOYMENT_MISMATCH",
      "Signed deployment differs",
    );
    // Offline integrity first, so the owner never confirms an altered envelope.
    // Freshness is re-checked inside broadcast immediately before submission.
    await verifySigned(s.unsigned, s.txRaw);
    console.error(
      JSON.stringify(
        {
          operation: s.unsigned.operation,
          feeNgonka: s.unsigned.fee,
          gasReview: s.unsigned.gasReview,
        },
        null,
        2,
      ),
    );
    await consent("Owner authorizes sending this transaction");
    await save(p, { status: "PREPARING" });
    result = await broadcast(c, s, async (r) => {
      await updateReceipt(p, r);
    });
    // SUBMISSION_UNKNOWN (bytes already known to the node) needs tx confirm, not success.
    if (result.status !== "SUBMITTED") process.exitCode = 1;
  } else if (group === "tx" && command === "confirm") {
    const seconds = whole("timeout-seconds", 1, 900) ?? 120;
    result = await confirmReceipt(
      c,
      await load(str("receipt")!),
      seconds * 1000,
    );
    if (
      result.status !== "INCLUDED" ||
      result.postcondition?.status !== "RESULT_VERIFIED"
    )
      process.exitCode = 1;
  } else if (group === "report" && command === "readiness") {
    const host = str("host")!,
      targetEpoch = whole("epoch", 0, Number.MAX_SAFE_INTEGER),
      files = str("signing-proofs", false)?.split(",") ?? [];
    result = await readiness(c, {
      host,
      signer: str("signer", false),
      price: str("price", false),
      budget: str("budget", false),
      targetEpoch,
      proofs: await Promise.all(files.map(load)),
    });
    if (result.status !== "READY") process.exitCode = 1;
  } else throw new ToolError("USAGE", "Unknown command; run forward help", 2);
  if (result?.status === "INCOMPLETE" || result?.status === "FAILED")
    process.exitCode = 1;
  if (out !== undefined) await save(out, result);
  print(result);
}
main().catch((e) => {
  const error =
    e instanceof ToolError
      ? e
      : new ToolError("UNEXPECTED", e instanceof Error ? e.message : String(e));
  console.error(
    JSON.stringify({
      status: "FAILED",
      code: error.code,
      message: error.message,
    }),
  );
  process.exitCode = error.exitCode;
});

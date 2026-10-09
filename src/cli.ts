#!/usr/bin/env node
import { signedJsonBytes } from "./signed-json.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { Chain, same, hash } from "./chain.js";
import { fromBase64 } from "@cosmjs/encoding";
import {
  ToolError,
  requireFact,
  decimal,
  Deployment,
  Operation,
  Signed,
} from "./model.js";
import { prepare, status } from "./operations.js";
import {
  exportTx,
  verifySigned,
  checkFresh,
  broadcast,
  confirm,
  reconcile,
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
async function load(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
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
tx confirm --receipt FILE [--timeout-seconds 120] [--out RESULT]
report readiness --host ADDRESS [--signer ADDRESS] [--epoch N --price DECIMAL --budget DECIMAL] [--signing-proofs FILE1,FILE2,FILE3] --out REPORT
All commands support --deployment ID and emit JSON. Local outputs are excluded from Git when stored in .forward/.
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
  const deployment: Deployment = await load(
    str("deployment-file", false) ??
      join(
        root,
        "deployments",
        `${str("deployment", false) ?? "mainnet-v1"}.json`,
      ),
  );
  const c = new Chain(deployment);
  let result: any;
  if (group === "doctor") {
    requireFact(
      Number(process.versions.node.split(".")[0]) === 24,
      "NODE_VERSION",
      "Node.js 24 LTS required",
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
    const host = str("host")!;
    await c.verify();
    result = {
      status: "HOST_CHECKED",
      host,
      participant: await c.host(host),
      routes: await c.routes(host),
      balanceNgonka: await c.balance(host),
      signerCanRoute: (str("signer", false) ?? host) === host,
      note: "Routing requires participant owner; warm-key claim authz not implemented in v1",
    };
  } else if (group === "deal" && command === "status")
    result = await status(c, str("deal")!);
  else if (group === "deal" && command === "prepare") {
    const input: any = {};
    for (const k of ["deal", "role", "seed"])
      if (str(k, false)) input[k] = str(k);
    if (opts.epoch) input.epoch = Number(str("epoch"));
    if (opts.price) input.price = decimal(str("price")!);
    if (opts.budget) input.budget = decimal(str("budget")!);
    if (opts.emergency === true) input.emergency = true;
    result = await prepare(c, str("action") as any, str("sender")!, input);
    requireFact(opts.out, "USAGE", "--out required");
  } else if (group === "tx" && command === "export") {
    result = await exportTx(
      c,
      await load(str("operation")!),
      str("public-key", false),
      str("max-fee", false),
      str("claim-gas", false),
    );
    requireFact(opts.out, "USAGE", "--out required");
  } else if (group === "tx" && command === "sign") {
    requireFact(
      str("adapter") === "inferenced",
      "UNSUPPORTED_ADAPTER",
      "Use tx export/import for external signers",
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
    const folder = dirname(resolve(str("out")!));
    await mkdir(folder, { recursive: true });
    const txPath = join(folder, `unsigned-${Date.now()}.local.json`),
      signedPath = join(folder, `signed-${Date.now()}.local.json`);
    await save(txPath, u.tx);
    const adapter = new InferencedAdapter(
      str("cli")!,
      str("key")!,
      str("home")!,
      str("backend")!,
    );
    const raw = await adapter.sign(u, {
      unsignedTx: txPath,
      signedTx: signedPath,
    });
    result = await verifySigned(u, raw);
  } else if (group === "tx" && command === "import") {
    const u = await load(str("unsigned")!);
    await checkFresh(c, u);
    result = await verifySigned(u, await signedBytes(str("signed-tx")!));
  } else if (group === "tx" && command === "broadcast") {
    requireFact(
      opts.confirm === true,
      "OWNER_CONFIRMATION",
      "--confirm required for explicit submission",
    );
    const s: Signed = await load(str("signed")!);
    requireFact(
      same(s.unsigned.operation.deployment, deployment),
      "DEPLOYMENT_MISMATCH",
      "Signed deployment differs",
    );
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
    const p = str("receipt")!;
    await save(p, { status: "PREPARING" });
    result = await broadcast(c, s, async (r) => {
      await updateReceipt(p, r);
    });
  } else if (group === "tx" && command === "confirm") {
    const r = await load(str("receipt")!);
    requireFact(
      r.signed &&
        same(r.signed.unsigned.operation, r.operation) &&
        hash(fromBase64(r.signed.txRaw)).toUpperCase() === r.txHash,
      "RECEIPT_BINDING",
      "Receipt operation and signed transaction hash must match",
    );
    await verifySigned(r.signed.unsigned, r.signed.txRaw);
    requireFact(
      same(r.operation?.deployment, deployment),
      "DEPLOYMENT_MISMATCH",
      "Receipt deployment differs",
    );
    result = await confirm(
      c,
      r.txHash,
      r.nextHeight ?? r.fromHeight,
      Number(str("timeout-seconds", false) ?? 120) * 1000,
    );
    result = { ...r, ...result };
    if (result.status === "INCLUDED")
      result.postcondition = await reconcile(c, r.operation);
    if (result.status !== "INCLUDED") process.exitCode = 1;
  } else if (group === "report" && command === "readiness") {
    const files = str("signing-proofs", false)?.split(",") ?? [];
    result = await readiness(c, {
      host: str("host")!,
      signer: str("signer", false),
      price: str("price", false),
      budget: str("budget", false),
      targetEpoch: opts.epoch ? Number(str("epoch")) : undefined,
      proofs: await Promise.all(files.map(load)),
    });
    if (result.status !== "READY") process.exitCode = 1;
  } else throw new ToolError("USAGE", "Unknown command; run forward help", 2);
  if (result?.status === "INCOMPLETE" || result?.status === "FAILED")
    process.exitCode = 1;
  if (opts.out) await save(str("out")!, result);
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

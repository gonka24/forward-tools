#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { Chain, same } from "./chain.js";
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
tx export --operation FILE [--public-key BASE64] [--max-fee NGONKA] --out UNSIGNED
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
  const x = await load(file);
  if (typeof x.tx_bytes === "string") return x.tx_bytes;
  // Cosmos CLI's JSON is converted to TxRaw with the same wire representation.
  const { TxRaw, TxBody, AuthInfo } = await import(
    "cosmjs-types/cosmos/tx/v1beta1/tx"
  );
  const { PubKey } = await import("cosmjs-types/cosmos/crypto/secp256k1/keys");
  const { encoded } = await import("./transactions.js");
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
                key: Buffer.from(s.public_key.key, "base64"),
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
    signatures: x.signatures.map((s: string) => Buffer.from(s, "base64")),
  });
  return Buffer.from(TxRaw.encode(raw).finish()).toString("base64");
}
async function main() {
  if (!group || group === "help" || group === "--help") {
    help();
    return;
  }
  parse();
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
    if (opts.emergency) input.emergency = true;
    result = await prepare(c, str("action") as any, str("sender")!, input);
    requireFact(opts.out, "USAGE", "--out required");
  } else if (group === "tx" && command === "export") {
    result = await exportTx(
      c,
      await load(str("operation")!),
      str("public-key", false),
      str("max-fee", false),
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
        { operation: u.operation, feeNgonka: u.fee, gas: u.gas },
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
    await adapter.sign(u, { unsignedTx: txPath, signedTx: signedPath });
    result = await verifySigned(u, await signedBytes(signedPath));
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
        { operation: s.unsigned.operation, feeNgonka: s.unsigned.fee },
        null,
        2,
      ),
    );
    await consent("Owner authorizes sending this transaction");
    const p = str("receipt")!;
    await save(p, { status: "PREPARING" });
    result = await broadcast(c, s, async (r) => {
      await writeFile(p, JSON.stringify(r, null, 2) + "\n");
    });
  } else if (group === "tx" && command === "confirm") {
    const r = await load(str("receipt")!);
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

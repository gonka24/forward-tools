/** Offline CLI boundaries: every case must be rejected before any RPC, file read or owner prompt. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { toBech32 } from "@cosmjs/encoding";
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url)),
  dir = mkdtempSync(join(tmpdir(), "forward-cli-")),
  host = toBech32("gonka", new Uint8Array(20).fill(5)),
  existing = join(dir, "existing.local.json");
writeFileSync(existing, "{}\n");
function run(...args: string[]) {
  const r = spawnSync(process.execPath, [cli, ...args], {
    cwd: dir,
    encoding: "utf8",
    timeout: 20000,
  });
  const last = r.stderr.trim().split(/\r?\n/).at(-1) ?? "";
  return {
    status: r.status,
    error: last.startsWith("{") ? JSON.parse(last) : {},
  };
}
const offer = (epoch: string, out = join(dir, "offer.local.json")) => [
  "deal",
  "prepare",
  "--action",
  "create-offer",
  "--sender",
  host,
  "--epoch",
  epoch,
  "--price",
  "1",
  "--budget",
  "10",
  "--out",
  out,
];
test("commercial epoch accepts only canonical decimal integers", () => {
  // Number() would read these as 10, 11, 11 and 11.
  for (const epoch of ["1e1", "0x0B", "11.0", "011"]) {
    const r = run(...offer(epoch));
    assert.equal(r.status, 2, epoch);
    assert.equal(r.error.code, "USAGE", epoch);
  }
});
test("an existing output is refused before any network or signing work", () => {
  const prepared = run(...offer("11", existing));
  assert.equal(prepared.status, 2);
  assert.equal(prepared.error.code, "OUTPUT_EXISTS");
  // The receipt check precedes loading the (missing) signed file and the owner prompt.
  const sent = run(
    "tx",
    "broadcast",
    "--signed",
    join(dir, "missing.local.json"),
    "--receipt",
    existing,
    "--confirm",
  );
  assert.equal(sent.status, 2);
  assert.equal(sent.error.code, "OUTPUT_EXISTS");
  assert.equal(readFileSync(existing, "utf8"), "{}\n");
});
test("signing arguments are complete before the unsigned file or chain is consulted", () => {
  const r = run(
    "tx",
    "sign",
    "--unsigned",
    join(dir, "missing.local.json"),
    "--adapter",
    "inferenced",
    "--key",
    "synthetic",
    "--home",
    dir,
    "--backend",
    "file",
    "--out",
    join(dir, "signed.local.json"),
  );
  assert.equal(r.status, 2);
  assert.equal(r.error.code, "USAGE");
  assert.match(r.error.message, /--cli/);
});
test("confirmation timeout is a bounded decimal number of seconds", () => {
  for (const seconds of ["1e3", "0", "901", "abc"]) {
    const r = run(
      "tx",
      "confirm",
      "--receipt",
      join(dir, "missing.local.json"),
      "--timeout-seconds",
      seconds,
    );
    assert.equal(r.status, 2, seconds);
    assert.equal(r.error.code, "USAGE", seconds);
  }
});
test("deployment selection cannot escape the registry or verify an empty node list", () => {
  const escaped = run("deployment", "verify", "--deployment", "../package");
  assert.equal(escaped.status, 2);
  assert.equal(escaped.error.code, "USAGE");
  const both = run(
    "deployment",
    "verify",
    "--deployment",
    "mainnet-v1",
    "--deployment-file",
    existing,
  );
  assert.equal(both.error.code, "USAGE");
  const registry = JSON.parse(
    readFileSync(
      new URL("../../deployments/mainnet-v1.json", import.meta.url),
      "utf8",
    ),
  );
  const empty = join(dir, "empty-nodes.local.json");
  writeFileSync(empty, JSON.stringify({ ...registry, nodes: [] }));
  const vacuous = run("deployment", "verify", "--deployment-file", empty);
  assert.equal(vacuous.status, 1);
  assert.equal(vacuous.error.code, "INVALID_DEPLOYMENT");
});

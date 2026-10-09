import { spawnSync } from "node:child_process";
import { Unsigned, requireFact } from "../model.js";
import { SigningAdapter } from "../transactions.js";
import { EXEC } from "../operations.js";
import { ROUTE, CLAIM } from "../native.js";
import { address } from "../chain.js";
import { same } from "../chain.js";
import { verifySigned } from "../transactions.js";
import { signedJsonBytes } from "../signed-json.js";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
export class InferencedAdapter implements SigningAdapter {
  capabilities = { direct: true, typeUrls: [EXEC, ROUTE, CLAIM] };
  constructor(
    public executable: string,
    public keyName: string,
    public home: string,
    public backend: string,
  ) {
    requireFact(
      ["os", "file"].includes(backend),
      "KEYRING_BACKEND",
      "Use encrypted os or file keyring",
    );
  }
  async getAddress() {
    const r = spawnSync(
      this.executable,
      [
        "keys",
        "show",
        this.keyName,
        "--address",
        "--home",
        this.home,
        "--keyring-backend",
        this.backend,
      ],
      { stdio: ["inherit", "pipe", "inherit"], encoding: "utf8", shell: false },
    );
    requireFact(
      r.status === 0,
      "SIGNER_UNAVAILABLE",
      "Cannot read public signing address",
    );
    return address(r.stdout.trim().split(/\s+/).at(-1)!);
  }
  async sign(u: Unsigned, paths?: { unsignedTx: string; signedTx: string }) {
    if (!paths) {
      const parent = resolve(".forward");
      await mkdir(parent, { recursive: true });
      const dir = await mkdtemp(join(parent, "signing-"));
      paths = {
        unsignedTx: join(dir, "unsigned.local.json"),
        signedTx: join(dir, "signed.local.json"),
      };
      await writeFile(paths.unsignedTx, JSON.stringify(u.tx), { flag: "wx" });
    }
    requireFact(
      same(JSON.parse(await readFile(paths.unsignedTx, "utf8")), u.tx),
      "UNSIGNED_FILE_CHANGED",
      "Signing input file differs from reviewed unsigned transaction",
    );
    requireFact(
      (await this.getAddress()) === u.operation.sender,
      "SIGNER_MISMATCH",
      "Selected key address differs",
    );
    // No shell interpolation or password capture: the owner unlocks the keyring in their terminal.
    const r = spawnSync(
      this.executable,
      [
        "tx",
        "sign",
        paths.unsignedTx,
        "--overwrite",
        "--from",
        this.keyName,
        "--home",
        this.home,
        "--keyring-backend",
        this.backend,
        "--chain-id",
        u.operation.deployment.chainId,
        "--offline",
        "--account-number",
        u.accountNumber,
        "--sequence",
        u.sequence,
        "--sign-mode",
        "direct",
        "--output-document",
        paths.signedTx,
      ],
      { stdio: "inherit", shell: false },
    );
    requireFact(r.status === 0, "SIGNING_FAILED", "inferenced signing failed");
    const raw = signedJsonBytes(
      JSON.parse(await readFile(paths.signedTx, "utf8")),
    );
    await verifySigned(u, raw);
    return raw;
  }
}

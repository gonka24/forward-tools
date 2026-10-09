import { spawnSync } from "node:child_process";
import { Unsigned, requireFact } from "../model.js";
import { SigningAdapter } from "../transactions.js";
import { EXEC } from "../operations.js";
import { ROUTE, CLAIM } from "../native.js";
import { address } from "../chain.js";
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
  async sign(u: Unsigned, paths: { unsignedTx: string; signedTx: string }) {
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
    return paths.signedTx;
  }
}

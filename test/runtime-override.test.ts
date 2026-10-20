/** Synthetic RPC fixtures only; no live transactions. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Chain, hash, type ChainOptions } from "../src/chain.js";
import type { Deployment } from "../src/model.js";
const bytes = new Uint8Array([1, 2, 3]);
const digest = hash(bytes);
const deployment: Deployment = {
  ...JSON.parse(readFileSync("deployments/mainnet-v1.json", "utf8")),
  nodes: ["https://one.invalid", "https://two.invalid"],
  factoryHash: digest,
  dealHash: digest,
  tokenHash: digest,
};
function fixture(options: ChainOptions = {}, broken = "") {
  return new Chain(
    deployment,
    async (url) => {
      if (url.endsWith("/status"))
        return {
          result: {
            node_info: {
              network: broken === "chain" ? "wrong" : deployment.chainId,
            },
            sync_info: {
              catching_up: false,
              latest_block_time: new Date().toISOString(),
              latest_block_height: "100",
            },
          },
        };
      if (url.endsWith("/node_info")) {
        if (broken === "rpc") throw new Error("RPC unavailable");
        return { application_version: { git_commit: "new-runtime" } };
      }
      if (url.includes("/code/"))
        return {
          data: Buffer.from(bytes).toString("base64"),
          code_info: {
            data_hash: broken === "code" ? "bad" : digest,
            instantiate_permission: { permission: "Everybody" },
          },
        };
      if (url.includes("/smart/")) {
        const query = JSON.parse(
          Buffer.from(
            decodeURIComponent(url.split("/smart/")[1]!),
            "base64",
          ).toString(),
        );
        if (query.config)
          return {
            data: {
              deal_code_id: deployment.dealCodeId,
              settlement_cw20: deployment.token,
              fee_recipient: deployment.feeRecipient,
              fee_bps: deployment.feeBps,
            },
          };
        if (query.token_info)
          return {
            data: {
              symbol: broken === "token" ? "OTHER" : "USDT",
              decimals: 6,
            },
          };
        return {
          data: {
            chain_id: "ethereum",
            contract_address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
          },
        };
      }
      const address = url.split("/").at(-1);
      return {
        address,
        contract_info: {
          code_id: deployment.factoryCodeId,
          admin: broken === "admin" ? "owner" : "",
        },
      };
    },
    undefined,
    options,
  );
}
test("runtime override is opt-in, exact and explicitly overridable", async () => {
  const previous = process.env.GONKA_FORWARD_ASSUME_RUNTIME_COMPATIBLE;
  try {
    for (const value of [undefined, "false", "1", "TRUE"]) {
      if (value === undefined)
        delete process.env.GONKA_FORWARD_ASSUME_RUNTIME_COMPATIBLE;
      else process.env.GONKA_FORWARD_ASSUME_RUNTIME_COMPATIBLE = value;
      await assert.rejects(fixture().verify(), { code: "RUNTIME_CHANGED" });
    }
    process.env.GONKA_FORWARD_ASSUME_RUNTIME_COMPATIBLE = "true";
    const result = await fixture().verify();
    assert.equal(result.observations.length, 2);
    for (const observation of result.observations) {
      assert.equal(observation.runtimeCompatibility, "ASSUMED");
      assert.equal(observation.gonkaSha, "new-runtime");
    }
    await assert.rejects(fixture({ assumeRuntimeCompatible: false }).verify(), {
      code: "RUNTIME_CHANGED",
    });
  } finally {
    if (previous === undefined)
      delete process.env.GONKA_FORWARD_ASSUME_RUNTIME_COMPATIBLE;
    else process.env.GONKA_FORWARD_ASSUME_RUNTIME_COMPATIBLE = previous;
  }
});
test("browser option skips only runtime equality on every node", async () => {
  assert.equal(
    (await fixture({ assumeRuntimeCompatible: true }).verify()).observations
      .length,
    2,
  );
  for (const [broken, code] of [
    ["chain", "WRONG_CHAIN"],
    ["admin", "FACTORY_MISMATCH"],
    ["code", "CODE_MISMATCH"],
    ["token", "TOKEN_MISMATCH"],
  ]) {
    await assert.rejects(
      fixture({ assumeRuntimeCompatible: true }, broken).verify(),
      { code },
    );
  }
  await assert.rejects(
    fixture({ assumeRuntimeCompatible: true }, "rpc").verify(),
    /RPC unavailable/,
  );
});

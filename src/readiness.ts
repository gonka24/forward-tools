import { Chain, same, hash } from "./chain.js";
import {
  epoch,
  decimal,
  economics,
  ToolError,
  requireFact,
  Signed,
} from "./model.js";
import { verifySigned } from "./transactions.js";
import { EXEC } from "./operations.js";
import { ROUTE, CLAIM } from "./native.js";
import { fromBase64 } from "@cosmjs/encoding";
export async function readiness(
  c: Chain,
  input: {
    host: string;
    signer?: string;
    price?: string;
    budget?: string;
    targetEpoch?: number;
    proofs?: Signed[];
  },
) {
  const blockers: string[] = [];
  let verification: any, participant: any, routes: any, balance: any;
  try {
    verification = await c.verify();
    participant = await c.host(input.host);
    routes = await c.routes(input.host);
    balance = await c.balance(input.host);
    if (BigInt(balance) === 0n) blockers.push("GNK for gas missing");
  } catch (e) {
    blockers.push(e instanceof ToolError ? e.code : "CHECK_FAILED");
  }
  if (!input.signer || input.signer !== input.host)
    blockers.push("Participant owner signing address not confirmed");
  const terms =
    input.price && input.budget && input.targetEpoch !== undefined
      ? {
          price: decimal(input.price),
          budget: decimal(input.budget),
          epoch: epoch(input.targetEpoch),
        }
      : null;
  if (!terms) blockers.push("Commercial price, budget and epoch not agreed");
  const economicPreview = terms ? economics(terms.budget, terms.price) : null;
  if (terms && verification) {
    const E = await c.currentEpoch();
    if (terms.epoch <= E || terms.epoch > E + 40)
      blockers.push("Target epoch outside future window");
  }
  const capabilities = new Set<string>(),
    proofs: any[] = [];
  for (const s of input.proofs ?? []) {
    requireFact(
      same(s.unsigned.operation.deployment, c.deployment) &&
        s.unsigned.operation.sender === input.host,
      "SIGNING_PROOF_MISMATCH",
      "Signing proof must belong to this participant and deployment",
    );
    await verifySigned(s.unsigned, s.txRaw);
    for (const m of s.unsigned.operation.messages) capabilities.add(m.typeUrl);
    proofs.push({
      txHash: hash(fromBase64(s.txRaw)),
      messages: s.unsigned.operation.messages.map((m) => m.typeUrl),
    });
  }
  const missing = [EXEC, ROUTE, CLAIM].filter((t) => !capabilities.has(t));
  if (missing.length)
    blockers.push(
      "Signing method not yet demonstrated for: " + missing.join(", "),
    );
  return {
    schema: "gonka24/forward-readiness/1",
    status: blockers.length ? "INCOMPLETE" : "READY",
    environmentReady: !!verification,
    hostVerified: !!participant,
    commercialTermsAgreed: !!terms,
    signingCapabilitiesVerified: missing.length === 0,
    operationPrepared: false,
    signed: false,
    included: false,
    resultVerified: false,
    host: input.host,
    signer: input.signer,
    terms,
    economicPreview,
    verification,
    participant,
    routes,
    balanceNgonka: balance,
    signingProofs: proofs,
    blockers,
    nextSteps: missing.length
      ? [
          "Rehearse owner signing method using prepared operations; broadcast requires separate authorization",
          "After offer creation verify Deal, set routing before E, then buyer funds",
        ]
      : [
          "Prepare agreed offer",
          "After offer creation verify Deal, set routing before E, then buyer funds",
        ],
    note: "READY describes preparation capabilities; it does not authorize transactions or prove a deal completed",
  };
}

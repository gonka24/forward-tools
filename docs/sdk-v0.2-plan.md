# Tools v0.2 — shared TypeScript SDK

Authorized scope: typed reusable SDK for frontend and keeper, Keplr adapter,
common signing adapter interface, documentation and offline validation. No Rust
HTTP service, keeper scheduler, deployment, publishing or live financial actions.

Keep the existing operation/unsigned/signed/receipt wire versions and deployment
registry. Prepare, sign, submit and confirm remain separate calls. Persist the
receipt before submission; unknown outcomes resume the same hash. Funding remains
CW20 Send with Fund hook and the verified full Deal budget.

Acceptance: typed action inputs and SDK calls; wallet validates selected identity
and immutable signing bytes; custom keeper signer uses the same verification;
tests cover changed messages/fee/network, rejection and uncertain outcomes.
Existing CLI stays supported. Browser entry points must not import Node builtins.

Validation budget: dependency installation, offline npm tests/build, npm audit,
package inspection and independent code review, bounded to this change. No GPU,
Docker or chain transactions needed. Stop and report unavailable real-wallet
validation rather than treating synthetic tests as Gonka/Keplr compatibility.

Status: implementation complete locally; 105 offline tests, dependency audit,
independent review and extracted-package consumer checks passed. Evidence and
limits are recorded in validation.md. Live Keplr/Gonka validation remains
unperformed. The owner subsequently authorized a branch push and pull request
for review. Release publication and merge remain separate actions.

The frontend product-mvp.md Tools architecture wording was updated to TypeScript
SDK/CLI and separate frontend/keeper signing adapters; Monitoring remains Rust.

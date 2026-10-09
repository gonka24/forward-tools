# Validation status

This document is updated with executed checks before the first release.

- Offline unit tests: in progress.
- Mainnet read-only verification: passed on both configured nodes at height 6475628.
  Factory/deal/token binaries, no-admin Factory policy, metadata and runtime matched.
- Full CLI local Gonka positive settlement and refund: pending.
- inferenced signing adapter on local chain: pending.
- Clean-environment handoff rehearsal: pending.
- Keplr, Leap and hardware adapters: not implemented/verified.

Earlier contract E2E evidence is linked in the deployment registry. It proves
contract scenarios, not execution of this new tools CLI. CI runs offline tests
only; a local live validation run is a separate result.

Do not claim pilot signing readiness before the host's actual method is verified.

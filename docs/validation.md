# Validation status

This document is updated with executed checks before the first release.

- Offline unit tests: 54 passed on Windows Node 24.13.0. Platform CI passed for
  the preceding c4d817b revision; the final revision is checked again before release.
- Mainnet read-only verification: passed on both configured nodes at height 6475628.
  Factory/deal/token binaries, no-admin Factory policy, metadata and runtime matched.
- Full CLI local Gonka positive settlement and refund: pending.
- inferenced signing adapter: offline encrypted-file keyring rehearsal passed
  with the pinned release CLI for MsgExecuteContract, MsgSetClaimRecipients and
  MsgClaimRewards, including empty recipient and zero seed default-field cases;
  generated synthetic fixture keyring deleted. No user wallet
  or network was used. Actual local-chain execution remains pending below.
- Clean-environment handoff rehearsal: passed from a fresh public Git clone:
  npm ci, build, tests, doctor and two-node mainnet preflight. Actual host identity,
  terms and signing method remain participant-specific inputs.
- Keplr, Leap and hardware adapters: not implemented/verified.

Earlier contract E2E evidence is linked in the deployment registry. It proves
contract scenarios, not execution of this new tools CLI. CI runs offline tests
only; a local live validation run is a separate result.

Do not claim pilot signing readiness before the host's actual method is verified.

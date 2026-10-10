# Executed validation for v0.1.0

- Offline tests: **61 passed** on Windows Node 24.13.0. Linux, macOS and Windows
  CI passed for implementation revision `2f31470f6b125da86bd1e0c26e4673af38e729a3`:
  [CI run](https://github.com/gonka24/forward-tools/actions/runs/37998632114).
  Dependency audit reported zero vulnerabilities.
- Mainnet read-only verification passed on both nodes at height **6476721**.
  Factory, Deal and token binaries, Factory no-admin policy, token metadata/origin
  and Gonka runtime matched. No mainnet transaction was signed or broadcast.
- Local positive lifecycle **passed**: CreateOffer, routing, CW20 funding, Lock,
  native ClaimRewards, SettleClaim, three independent USDT withdrawals and GNK
  release. Independent financial assertions passed, including the rejected
  terminal repeat without another payout. Budget 100 local USDT: Host 93.353023,
  fee 1.421619, Buyer refund 5.225358; pending debts zero.
- Local positive-unclaimed claim-expiry refund **passed**: the positive summary
  remained unclaimed, refund was rejected at E+1 and succeeded at E+2. Refund
  transferred the full CW20 deposit atomically; repeat refund and competing
  settlement were rejected.
- Both selected JUnit scenarios executed one test with zero failures/errors/skips.
  **18 tools CLI transactions** were included and their postconditions verified.
  Both product snapshots were `UNCHANGED`; private Docker resources were cleaned.
  The background process exited 0.
- The actual pinned inferenced CLI passed an offline encrypted **file** keyring
  rehearsal for all three message types, empty recipient and zero seed. Synthetic
  keyring deleted; CLI checksum is in development.md. Local lifecycle used the
  same CLI through external export/import. The `os` backend is exposed but was
  not independently rehearsed as a tools adapter here.
- Clean public-checkout handoff rehearsal passed installation, build, tests,
  doctor, mainnet preflight and an incomplete readiness report with real blockers.
- Keplr, Leap, hardware and multisig adapters are **not implemented/verified**.

The [portable summary](../validation/local-v0.1.0.json) records scenario IDs,
per-operation tools revisions, hashes/heights and raw evidence digests. Positive
lifecycle used `86fb2a1`; refund used the recorded later revisions. Subsequent
changes added uint64 rejection, incomplete vesting diagnostics and documentation;
their offline/CI tests passed. Do not claim that one frozen final tools revision
executed every recorded operation.

Local execution used unmodified Gonka `136041c81ea8ff38e7620d76af66a7c7fe7eec50`,
contracts `4092b665c97b87f937d4c4c230870cebb038a4d8`, the production CW20 binary
and synthetic balances/keys. This is tools integration evidence, **not mainnet
financial execution or a new graded immutable-source runner E2E package**.
Acceptance remains `NOT_REVIEWED`. Raw local evidence stays private because it
contains environment paths and synthetic node keyring configuration.

The pinned native claim simulator panics on an empty header hash. Default export
blocks; the local fixture explicitly selected 1,000,000 gas via `--claim-gas`.
Actual native claim inclusion succeeded. This is not successful simulation: real
owners must review their own gas budget and possible gas loss. No network code
was changed to handle this limitation.

Earlier contract E2E evidence is linked in the registry; it does not substitute
for these tools tests. Pilot readiness still depends on the actual host's signing
method and agreed terms.

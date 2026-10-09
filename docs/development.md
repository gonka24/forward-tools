# Development and validation

Use Node 24.13.0, `npm ci --ignore-scripts`, `npm test`, and `npm audit`.
The GitHub workflow runs offline tests on Linux, Windows and macOS. Tests do not
call RPC or Docker. Wallet secrets and real financial transactions never run in CI.

Core modules have no Node builtins/Buffer dependencies; wallet adapters and file
operations live outside the browser-reusable core. Keep operation generation,
signature verification and submission separate. Re-run tests after changes.

## Live local validation

`test/integration/harness.py` instruments the independent pinned E2E harness:
successful participant operations use the tools CLI; upstream Testermint still
drives native epochs, compute, claim prerequisites and financial assertions.
The product snapshots and runner checkout remain unchanged. This is a **tools
integration**, not a newly graded immutable-source E2E run of the runner.

It requires an existing successful `forward-e2e` build with Gonka
`136041c81ea8ff38e7620d76af66a7c7fe7eec50`, contracts
`4092b665c97b87f937d4c4c230870cebb038a4d8`, mainnet-USDT local token mode,
and the reviewed runner `06fb0bec12ff23d12c0189805ddaf82fdf26bd6b`.
Build these through forward-e2e's documented explicit-SHA workflow first.

Mount its workspace and private Docker data-root into a privileged runner
container, mount this checkout as `/tools`, and set `TOOLS_E2E_RUN_ROOT` to the
existing run directory. Never mount the host Docker socket. No other runner may
use the same workspace/data-root concurrently; the supervisor takes an exclusive
lock. Provide verified Node 24.13.0 at `/tools/.forward/node24/bin/node`.

Execute `python3 -B /tools/test/integration/run.py`. It runs positive terminal
release and positive claim-expiry refund scenarios, records CLI operation receipts
and postconditions, and records/cleans newly created private Docker resources
between scenarios. Raw results are under `.forward/local-live/`, ignored by Git.
The runner's E2E verifier is not modified or bypassed; grading that evidence as a
new E2E proof is outside this integration's scope.

Signing rehearsal uses the actual release CLI with checksum
`2f6a31c3ecda063a84fcfd80782fe5b00908f9b678da9204d6c7acba602260de`:
`python3 -B /tools/test/integration/signing-rehearsal.py PATH_TO_EXECUTABLE_CLI`.
It creates a disposable encrypted file keyring, signs all three supported wire
types offline through the adapter, verifies signatures, then deletes that fixture
keyring. The fixed synthetic password belongs only to the test fixture; it is
never a user password. No existing keyring is read. Keep its output separate from
chain lifecycle validation.

Public validation summaries must name actual results, tested source revisions,
runtime versions, limitations and evidence digests. Never publish local keyrings,
wallet mnemonics or participant configurations as evidence.

# Source provenance

The native .proto and keeper .go references in this directory are unmodified
source files from `gonka-ai/gonka` commit
`136041c81ea8ff38e7620d76af66a7c7fe7eec50` (Gonka License, based on Apache-2.0;
the complete upstream license is retained in GONKA-LICENSE).
`deal.rs` and `factory.rs` are unmodified references from `gonka24/forward-contracts`
commit `4092b665c97b87f937d4c4c230870cebb038a4d8`. Their upstream license is retained
in CONTRACTS-LICENSE. These references document the guards and wire encoders;
they are not built or executed by tools.

Public deployment checks and block scanning were adapted from the reviewed pilot
preparation package of `forward-e2e`. Sources and hashes are recorded in the
deployment registry, including the public release of contract E2E evidence.
The adapted implementation is independently tested; it does not change the runner.

Factory instantiate mainnet receipt:
`50686677563C6A015A2B8226D1282E71718D986DCECE737083F7909EE513D851`, height 6475270.
Deal store: `E76BA3A20F15F7B15B330302FC5442D85CB77A24BB6BA6E8412B703752DD20FE`.
Factory store: `C2E1F51F424BEE66B54A7567E790AE6A1A19E48228CB108C4EEAB78F97161C2E`.

Deployment verification checks chain-reported identity/checksums through HTTPS RPC;
it is not a light-client proof of consensus or proof of bridge reserves.
The pinned Gonka runtime retains its upstream advisory limitations; tools cannot
repair network software. See the contract evidence release for the existing audit.

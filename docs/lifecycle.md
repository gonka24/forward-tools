# Lifecycle and authority

All addresses below are Gonka addresses. USDT is the pinned CW20 in Gonka;
GNK pays network gas. An Ethereum address is not a Deal payment recipient.
`Caller` means any account paying gas, not an administrator: the immutable
contract chooses the recipient and amount, regardless of the caller.

| CLI action | Sender | When | Effect |
| --- | --- | --- | --- |
| `create-offer` | Compute participant owner | Future E, at most current + 40 | Factory creates and registers an Open Deal with immutable terms |
| `route` | Same participant owner | Before E; Deal Open or Funded | Sets only this epoch's reward destination to the verified Deal |
| `remove-route` | Same participant owner | Before E; any Deal state | Removes only this epoch's destination |
| `fund` | Buyer | Open, before E, exact routing | CW20 Send with Fund hook; exact budget binds Buyer |
| `lock` | Caller | Open/Funded, E..E+4, exact routing | Saves recipient proof; missing Buyer is not fabricated |
| `claim` | Participant owner in v1 | E+1, Deal Open/Funded/Locked, not already claimed, exact routing | Native rewards claim using the participant's committed integer seed |
| `settle` | Caller | Locked proof and confirmed native claim | Freezes reward allocation and records independent USDT debts |
| `withdraw` | Caller | Chosen role has positive pending USDT | Pays immutable Host, Fee or Buyer recipient; a separate transaction per role |
| `release` | Caller | Releasing/Completed/Refunded/Expired with liquid GNK | Releases available GNK under the frozen allocation policy |
| `forward-excess` | Caller | Completed with liquid GNK | Same frozen policy for additional GNK |
| `refund` | Caller | Funded with routing mismatch in E..E+4, or Locked unclaimed from E+2 | Atomically returns the funded budget to Buyer and records Refunded; without Buyer records Expired |
| `cancel` | Host before E; caller from E | Open without Buyer, before E+5, no exact routing | Cancels unfunded offer |

An unavailable routing/summary query is a blocker, not proof of a mismatch or
missing reward. Only the contract's explicit emergency refund route can be
reviewed from E+3; it still needs successful simulation. Native claim's pinned
simulation defect is a different case: README describes the explicit gas review,
which does not establish successful simulation or completed execution.

`Lock` has a deadline. `SettleClaim` does not become impossible merely because
the saved routing entry was later pruned. Do not substitute a refund for a
confirmed claim. A permanent refund means any subsequently arriving GNK follows
the contract's Host allocation; the tools cannot reverse it.

Settlement, withdrawal and GNK release are distinct operations. `Completed`
does not imply that all USDT recipients withdrew their debts or that all future
GNK vesting finished. Continue `deal status`, withdraw each pending role and
release newly liquid GNK as required.
Refund is different: in this deployed version its CW20 transfer happens inside
the Refund transaction. If that transfer fails, the whole Refund rolls back.
Do not invent a separate pending Buyer withdrawal after a successful Refund.

Each operation uses `prepare → export → sign/import → broadcast → confirm`.
An operation file is a checked proposal, a signed file is authorization of those
bytes, and a mempool response is submission only. Confirmation checks block
execution and a corresponding on-chain postcondition. Uncertainty is recovered
using the same hash, never automatic repeat submission.

The first version supports participant owner signatures directly. Warm-key
authz, multisig, Keplr, Leap and hardware integrations need separately verified
adapters; displaying a balance does not establish message signing support.

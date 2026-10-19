# Shared SDK for frontend and keeper

Version 0.2 adds `ForwardClient`, typed action inputs and a Keplr adapter to the
existing TypeScript tools. The CLI remains available. This package does not run
an HTTP service, store wallet keys or schedule keeper jobs. Existing operation,
unsigned, signed and receipt wire identifiers remain unchanged.

The core entry point has no Node signing dependency. Import `KeplrAdapter` from
`@gonka24/forward-tools/keplr`; the optional local CLI adapter lives at
`@gonka24/forward-tools/inferenced`. Use an explicitly verified deployment record
with `new Chain(deployment)`. Do not replace a deployment's pins with values from
a frontend document or an unverified server response.
The application must configure the target chain in Keplr before connecting;
the adapter does not automatically suggest or install chain configuration.

## Prepare and review

```ts
import { Chain, ForwardClient } from "@gonka24/forward-tools";
import { KeplrAdapter } from "@gonka24/forward-tools/keplr";

// deployment is the selected immutable registry entry; provider is the browser
// extension object supplied by the application after the user chooses Keplr.
const client = new ForwardClient(new Chain(deployment));
const adapter = new KeplrAdapter(provider, deployment.chainId);
const identity = await adapter.connect();
const operation = await client.prepare({
  action: "fund",
  sender: identity.address,
  input: { deal: selectedDealAddress },
});
const unsigned = await client.exportTx(operation, {
  publicKey: identity.publicKey,
});
// Display reviewed terms, exact messages, network, signer, fee and any gasReview.
// Invoke this only after the user chooses to sign the reviewed transaction.
const signed = await client.sign(unsigned, adapter);
```

This example expects application-owned `deployment`, `provider` and
`selectedDealAddress`; it does not supply commercial defaults or send funds.
All `prepare` inputs are discriminated by `action`. `create-offer` takes `epoch`,
`price` and `budget`; price and budget are canonical integer **micro-USDT strings**.
For example, convert agreed display decimals with `decimal()` before preparing.
Epochs must fit a safe JavaScript integer. Claim `seed` is a canonical signed
int64 string from the existing public native claim workflow, never a wallet seed.
`withdraw` requires one role: `host`, `fee` or `buyer`.

Funding accepts only the verified Deal and signer. Tools obtains the complete
budget and configured CW20 from chain, checks routing, and constructs CW20 Send
with the funding hook. The application must not substitute Transfer. Creation
and routing are sequential: confirm creation, require a verified postcondition,
read its `deal` address, then prepare and sign a separate `route` action. Persist
each completed step so a page reload can resume without recreating the offer.

`sign` checks the unsigned representations, deployment, adapter capabilities,
public signer identity and live freshness before requesting a signature. A
private snapshot is retained while the adapter runs; returned bytes must verify
against it. Neither an external keeper adapter nor a browser wallet may change
messages, memo, signer, chain, account, sequence or fees. If the owner rejects the
fee, prepare a newly reviewed unsigned transaction. The Keplr adapter reports an
explicit user rejection as `WALLET_REJECTED`; other extension failures remain
`WALLET_FAILED` or a specific validation error.

## Submit separately and preserve uncertainty

```ts
const submission = await client.submit(signed, {
  approved: true, // the application has obtained separate submission approval
  saveReceipt: async (receipt) => {
    await durableStore.save(receipt.txHash, receipt);
  },
});
// Save the returned outcome/error as well, then confirm the SAME transaction.
const result = await client.confirm(submission.receipt);
await durableStore.save(result.txHash, result);
```

`saveReceipt` must resolve only after durable storage, including its initial
`SUBMISSION_UNKNOWN` receipt before the first submission request. IndexedDB or
an acknowledged persistent backend can implement this; an in-memory variable
does not satisfy the contract. The application chooses its storage policy and
must keep operation, unsigned, signed and receipt records. The callback receives
a copy. A failure to save the initial receipt prevents submission entirely.

`approved: true` is a caller assertion of approval, not user authentication or
an authorization service. Keep approval bound to the reviewed transaction in
the application. `sign` never submits; `submit` never signs or automatically
retries. If a transport error follows the durable receipt, it returns an outcome
with that receipt and a structured `error`. A later persistence failure returns
the last durable state conservatively, even if the node may have accepted bytes.

| Result | UI/keeper treatment |
| --- | --- |
| `SUBMITTED` | Node accepted bytes; inclusion remains unconfirmed. |
| `REJECTED` | Node explicitly rejected submission; show the error. |
| `SUBMISSION_UNKNOWN` | Preserve the hash and confirm it. Never prepare another payment automatically. |
| `INCOMPLETE` | Preserve `nextHeight`, `code` and original hash. Call `confirm(result)` to continue. |
| `FAILED` | Included execution failed; gas may have been consumed. |
| `INCLUDED` with `RESULT_VERIFIED` postcondition | Inclusion and expected action result verified. |
| `INCLUDED` with `UNVERIFIED` postcondition | Inclusion is known; expected action result is not verified. Show the cause and reconcile the same transaction. |

RPC/validation failures before any receipt are thrown as errors; a thrown error
is never success. Confirmation can also throw on unavailable network data. Keep
the previous durable receipt and recover the same hash. `confirm` does not write
storage or submit transactions. Do not interpret `Completed` Deal state as all
USDT paid or all future GNK received; those are separate observations.

## Custom keeper signing

Keeper integrations implement the same `SigningAdapter`:

```ts
import type { SigningAdapter } from "@gonka24/forward-tools";

const keeperSigner: SigningAdapter = {
  capabilities: { direct: true, typeUrls: supportedTypeUrls },
  getAddress: async () => publicKeeperAddress,
  sign: async (reviewedUnsigned) => externalSigner.signTxRaw(reviewedUnsigned),
};
const signed = await client.sign(unsigned, keeperSigner);
```

`sign` returns base64 protobuf TxRaw. The external signer owns key custody and
its policy; the SDK has no private-key parameter. Declare only exercised message
types. A keeper gas wallet can sign permissionless lock, settlement, withdrawals
and release, but has no implicit host routing or native-claim authority.
Withdraw each nonzero role separately. Scheduling, retries, durable work queues
and alerts belong to the keeper. Emergency refunds require an explicit operator
decision; RPC failure is not a normal-refund trigger.

Offline tests use synthetic wallets and RPC boundaries. They prove the SDK's
checks, not live Gonka/Keplr compatibility. The actual browser extension and
target runtime still require validation for each supported message type. The
adapter rejects hardware modes it has not implemented; no Amino, authz or
multisig support is implied. Only software secp256k1 direct signing is supported
by the current adapter interface. Keep the existing owner-selected claim-gas exception
and its `gasReview` warning distinct from successful simulation.

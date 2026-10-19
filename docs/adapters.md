# Signing adapters and external transactions

The operation envelope describes intent. It is not a wallet-specific import file.
The package root exports the browser-reusable core; the `/inferenced` subpath
exports the Node-specific optional signing adapter. `getAddress()` reads only the
public signer identity, and `capabilities` declares formats and type URLs.
`exportTx` builds a Cosmos transaction with fresh account number, sequence,
simulated gas and exact fee. A source-confirmed native claim simulation defect
requires an explicit owner-selected gas limit and records `gasReview`; it must
never be labelled successful simulation. It works without a wallet executable.

An adapter implements `SigningAdapter`, declares SIGN_MODE_DIRECT support and
supported type URLs, and returns a signed transaction.
Call `validateUnsigned(unsigned)` before invoking the wallet: it binds Cosmos
JSON and any direct SignDoc to the reviewed operation, sender, sequence and fee.
`checkFresh` also performs this check before live revalidation. Rejecting a
different transaction after signing cannot revoke the signature already created.
`sign(unsigned)` returns base64 protobuf TxRaw bytes, without filesystem paths
in the common interface. Browser wallets can consume `unsigned.signDoc` directly.
The adapter must not alter messages, memo, sender or fees. The wallet may reject the proposed fee; in that
case export a new reviewed transaction instead of silently accepting changes.

Supported wire messages:

- `/cosmwasm.wasm.v1.MsgExecuteContract`
- `/inference.inference.MsgSetClaimRecipients`
- `/inference.inference.MsgClaimRewards`

Native encoders are pinned to the deployed Gonka tx.proto. Claim recipient entries
use uint64 epoch field 1 and string recipient field 2. Claim uses creator field 1,
int64 seed field 2 and uint64 epoch_index field 3. Seed is a public committed
integer, not a wallet secret. Execution verifies native eligibility. The pinned
claim simulation defect described in README prevents a simulation proof for
that specific path; signature and other critical checks still apply.

External tools consume `unsigned.tx`; `unsigned.signDoc` also provides direct
protobuf body/auth bytes as base64, chain ID and account number. Chain ID and account number are in the
surrounding envelope. Direct signing signs protobuf SignDoc. Return Cosmos CLI
JSON or `{ "tx_bytes": "BASE64_TXRAW" }` to `tx import`. Signature verification
also proves the expected chain/account, which are not stored inside TxRaw itself.
The signature must be low-S: Cosmos SDK rejects high-S (malleable) signatures,
so `tx import` rejects them too even though generic ECDSA verifiers accept them.

Current adapter capabilities:

| Adapter | Preparation | Signature | Status |
| --- | --- | --- | --- |
| External direct secp256k1 | yes | caller provides signed bytes | Wire/signature verifier tested with synthetic signing key |
| inferenced | yes | owner terminal, os/file keyring | Runtime validation tracked in validation.md |
| Keplr software secp256k1 | yes | `/keplr` adapter, direct signing | Synthetic tests only; Gonka extension execution not verified |
| Leap / hardware / multisig | yes | adapter required | Not yet verified; no automatic support claim |

v0.2 does not support Amino, multisig, Ethereum signing, authz MsgExec or wallet
seed import. Wallet integrations can be developed separately using the existing
operation/export/import interfaces. Browser integration additionally needs UI,
wallet connection, protobuf registration and chain configuration; JSON alone
does not provide it.

For a new adapter, test address matching, all three wire types, signature binding,
fee/memo substitution, rejection, wrong network, hardware mode limitations and
local lifecycle execution. Declare only capabilities actually exercised.

Use `ForwardClient.sign` to revalidate chain state before signing with either a
keeper `SigningAdapter` or `KeplrAdapter`. The Keplr adapter takes an injected
provider and chain ID; it does not read `window` on import or broadcast. It asks
the extension to preserve fee/memo and rejects any changed SignDoc or public key.
Keplr's uint64 `Long` account is bridged without a JavaScript Number conversion.
Supported wire types describe encoder capability, not live wallet/network approval.
The application configures the target chain and handles explicit connection/signing
gestures. Hardware/Amino fallbacks and automatic chain suggestions are unsupported.

Provider contract was checked against the [Keplr signing documentation](https://docs.keplr.app/api/guide/sign-a-message)
and the published `@keplr-wallet/types` interface. `WALLET_REJECTED` is emitted only
for an explicit rejection (code 4001 or `Request rejected`); other wallet errors
remain `WALLET_FAILED`. Missing or malformed responses cannot establish success.

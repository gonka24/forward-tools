# Signing adapters and external transactions

The operation envelope describes intent. It is not a wallet-specific import file.
`exportTx` builds a Cosmos transaction with fresh account number, sequence,
simulated gas and exact fee. It works without a wallet executable.

An adapter implements `SigningAdapter`, declares SIGN_MODE_DIRECT support and
supported type URLs, and returns a signed transaction. The adapter must not alter
messages, memo, sender or fees. The wallet may reject the proposed fee; in that
case export a new reviewed transaction instead of silently accepting changes.

Supported wire messages:

- `/cosmwasm.wasm.v1.MsgExecuteContract`
- `/inference.inference.MsgSetClaimRecipients`
- `/inference.inference.MsgClaimRewards`

Native encoders are pinned to the deployed Gonka tx.proto. Claim recipient entries
use uint64 epoch field 1 and string recipient field 2. Claim uses creator field 1,
int64 seed field 2 and uint64 epoch_index field 3. Seed is a public committed
integer, not a wallet secret; simulation verifies native eligibility.

External tools consume `unsigned.tx`; `unsigned.signDoc` also provides direct
protobuf body/auth bytes as base64, chain ID and account number. Chain ID and account number are in the
surrounding envelope. Direct signing signs protobuf SignDoc. Return Cosmos CLI
JSON or `{ "tx_bytes": "BASE64_TXRAW" }` to `tx import`. Signature verification
also proves the expected chain/account, which are not stored inside TxRaw itself.

Current adapter capabilities:

| Adapter | Preparation | Signature | Status |
| --- | --- | --- | --- |
| External direct secp256k1 | yes | caller provides signed bytes | Wire/signature verifier tested with synthetic signing key |
| inferenced | yes | owner terminal, os/file keyring | Runtime validation tracked in validation.md |
| Keplr / Leap / hardware / multisig | yes | adapter required | Not yet verified; no automatic support claim |

v1 does not support Amino, multisig, Ethereum signing, authz MsgExec or wallet
seed import. Wallet integrations can be developed separately using the existing
operation/export/import interfaces. Browser integration additionally needs UI,
wallet connection, protobuf registration and chain configuration; JSON alone
does not provide it.

For a new adapter, test address matching, all three wire types, signature binding,
fee/memo substitution, rejection, wrong network, hardware mode limitations and
local lifecycle execution. Declare only capabilities actually exercised.

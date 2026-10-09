# Examples

`operation.example.json` demonstrates the versioned intent envelope. All identities,
amounts and source pins are synthetic. It is explicitly marked `test_fixture_only`
and the tools rejects it for transaction export. Generate live operations with
`deal prepare` after checking real agreed terms; never edit this example into a
production signing template.

For unsigned transactions, use `tx export`: account number, sequence, public key,
gas and direct signing bytes depend on the participant and current chain state.
Static examples cannot supply those facts correctly.

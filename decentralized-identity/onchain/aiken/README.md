# Decentralized Identity (Aiken)

This on-chain validator models a DID registry as a stateful UTxO. The datum stores the identity owner and a list of delegates with expiration times. Updates are performed by spending the UTxO and recreating it with a new datum.

## Structure

- `validators/identity.ak` implements the identity state machine.
- The datum is `IdentityDatum { owner, delegates }`.
- Redeemers cover `TransferOwner`, `AddDelegate`, and `RemoveDelegate` actions.

## Build

```sh
aiken build
```

## Test

```sh
aiken check
```

## Design Notes

- Owner signatures are mandatory for every state transition.
- Delegate additions must include a future expiry (`valid_before` check).
- The validator enforces a single continuing output and preserves the locked value.
- Delegate updates require monotonic list changes (+1 on add, -1 on remove).

## Example Datum

```json
{
  "owner": "<payment_key_hash>",
  "delegates": [
    { "key": "<delegate_key_hash>", "expires": 1893456000000 }
  ]
}
```

# factory — PyCardano scenario

End-to-end scenario for the factory validators against a local
[yaci-devkit] (`http://localhost:8080`).

## Validators

| Validator | Title | Params (in declaration order) |
| --------- | ----- | ----------------------------- |
| factory marker | `factory_marker.factory_marker.mint` | `(owner, utxo_ref)` |
| factory        | `factory.factory.spend`              | `(owner, factory_marker_policy)` |
| product (mint) | `product.product.mint`               | `(owner, factory_marker_policy, product_id)` |
| product (spend)| `product.product.spend`              | `(owner, factory_marker_policy, product_id)` — same params, used here implicitly |

`product_id` is a `ByteArray` parameter, so every distinct product gets its
own policy script. The factory's datum tracks the set of product policy ids
that have been authorised.

## Scenario

`run_scenario()` exercises the happy path:

1. **Fund** owner from the shared yaci test mnemonic (account 0).
2. **create_factory** — pick a seed UTxO, build the marker policy
   parameterised on it, mint the FACTORY_MARKER NFT and lock it at the
   factory script with an empty `FactoryDatum { products: [] }`.
3. **create_product (widget-001)** — single tx that:
   - spends the factory UTxO with `CreateProduct {product_policy_id, product_id}`,
   - mints exactly one (product_policy_id, product_id) token,
   - sends the new token to the product script address with a
     `ProductDatum { tag: "blue" }`,
   - continues the factory output with the product policy appended to
     `products`.
4. **create_product (widget-002)** — repeat with tag "red".
5. **read_product_tag** — fetch the inline datum from the product UTxO and
   confirm the tag.

The `product.spend` path is owner-only and not exercised here.

## Run

```bash
pip install -r requirements.txt
python factory.py
```

Requires yaci-devkit listening on `http://localhost:8080`.

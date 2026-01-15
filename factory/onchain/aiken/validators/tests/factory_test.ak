use factory.{CreateProduct}
use mocktail.{complete, mint, mocktail_tx, required_signer_hash}
use mocktail/virgin_key_hash.{mock_policy_id, mock_pub_key_hash}

const owner_pkh = mock_pub_key_hash(0)

const attacker = mock_pub_key_hash(1)

const factory_policy = mock_policy_id(0)

const product_id = "PRODUCT_1"

test factory_create_product_valid() {
  let tx =
    mocktail_tx()
      |> required_signer_hash(True, owner_pkh)
      |> mint(True, 1, factory_policy, product_id)
      |> complete()

  factory.factory.mint(
    owner_pkh,
    CreateProduct { product_id },
    factory_policy,
    tx,
  )
}

test factory_create_product_wrong_signer() {
  let tx =
    mocktail_tx()
      |> required_signer_hash(True, attacker)
      |> mint(True, 1, factory_policy, product_id)
      |> complete()

  !factory.factory.mint(
    owner_pkh,
    CreateProduct { product_id },
    factory_policy,
    tx,
  )
}

test factory_create_product_wrong_quantity() {
  let tx =
    mocktail_tx()
      |> required_signer_hash(True, owner_pkh)
      |> mint(True, 2, factory_policy, product_id)
      |> complete()

  !factory.factory.mint(
    owner_pkh,
    CreateProduct { product_id },
    factory_policy,
    tx,
  )
}

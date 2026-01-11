use cardano/assets.{from_asset}
use cardano/transaction.{InlineDatum, Input, Output}
use mocktail.{add_input, complete, mocktail_tx, required_signer_hash}
use mocktail/virgin_address.{mock_script_address}
use mocktail/virgin_key_hash.{mock_policy_id, mock_pub_key_hash}
use mocktail/virgin_output_reference.{mock_utxo_ref}
use product.{ProductDatum}

const owner_pkh = mock_pub_key_hash(0)

const attacker = mock_pub_key_hash(1)

const factory_policy = mock_policy_id(0)

const product_id = "PRODUCT_1"

const product_script_addr = mock_script_address(0, None)

test product_spend_valid_owner() {
  let oref = mock_utxo_ref(0, 0)

  let input =
    Input {
      output_reference: oref,
      output: Output {
        address: product_script_addr,
        value: from_asset(factory_policy, product_id, 1),
        datum: InlineDatum(ProductDatum { tag: "BACKROADS_BIO_KIT_V1" }),
        reference_script: None,
      },
    }

  let tx =
    mocktail_tx()
      |> required_signer_hash(True, owner_pkh)
      |> complete()
      |> add_input(True, input)

  product.product.spend(
    owner_pkh,
    factory_policy,
    product_id,
    None,
    None,
    oref,
    tx,
  )
}

test product_spend_invalid_signer() {
  let oref = mock_utxo_ref(0, 0)

  let input =
    Input {
      output_reference: oref,
      output: Output {
        address: product_script_addr,
        value: from_asset(factory_policy, product_id, 1),
        datum: InlineDatum(ProductDatum { tag: "SOLAR_MICROGRID_UNIT_A1" }),
        reference_script: None,
      },
    }

  let tx =
    mocktail_tx()
      |> required_signer_hash(True, attacker)
      |> complete()
      |> add_input(True, input)

  !product.product.spend(
    owner_pkh,
    factory_policy,
    product_id,
    None,
    None,
    oref,
    tx,
  )
}

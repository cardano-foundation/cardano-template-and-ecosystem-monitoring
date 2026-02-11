use cardano/assets.{PolicyId}

pub type FactoryDatum {
  products: List<PolicyId>,
}

pub type ProductDatum {
  tag: ByteArray,
}

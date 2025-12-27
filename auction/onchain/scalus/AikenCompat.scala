package scalus.examples.auction

import scalus.builtin.Data
import scalus.ledger.api.v1.{Credential, PolicyId}
import scalus.ledger.api.v2.{TxOut}
import scalus.ledger.api.v2.OutputDatum.{NoOutputDatum, OutputDatum}
import scalus.ledger.api.v3.{PubKeyHash, TxInInfo, TxInfo, TxOutRef}
import scalus.prelude.*

/** A lightweight set of helpers to mirror common Aiken conveniences */
object AikenCompat:

  // Address helpers
  inline def isToVerificationKey(out: TxOut, pkh: PubKeyHash): Boolean =
    out.address.credential === Credential.PubKeyCredential(pkh)

  inline def isToScript(out: TxOut, policyId: PolicyId): Boolean =
    out.address.credential === Credential.ScriptCredential(policyId)

  inline def outputsToVerificationKey(tx: TxInfo, pkh: PubKeyHash): List[TxOut] =
    tx.outputs.filter(o => isToVerificationKey(o, pkh))

  inline def outputsToScript(tx: TxInfo, policyId: PolicyId): List[TxOut] =
    tx.outputs.filter(o => isToScript(o, policyId))

  // Transaction helpers
  inline def findInput(tx: TxInfo, ref: TxOutRef): Option[TxInInfo] =
    tx.inputs.find(i => i.outRef === ref)

  inline def continuingOutputs(tx: TxInfo, out: TxOut): List[TxOut] =
    tx.outputs.filter(o => o.address === out.address)

  // Datum helpers
  inline def inlineDatum(out: TxOut): Option[Data] =
    out.datum match
      case OutputDatum(d) => scalus.prelude.Option.Some(d)
      case _              => scalus.prelude.Option.None

  // Signers & validity helpers
  inline def keySigned(tx: TxInfo, pkh: PubKeyHash): Boolean =
    tx.signatories.find(s => s === pkh).isDefined

  inline def validBefore(tx: TxInfo, t: BigInt): Boolean =
    tx.validRange.isEntirelyBefore(t)

  inline def validAfter(tx: TxInfo, t: BigInt): Boolean =
    tx.validRange.isEntirelyAfter(t)

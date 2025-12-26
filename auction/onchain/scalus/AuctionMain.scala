package scalus.examples.auction

import scalus.*
import scalus.uplc.*
import scalus.utils.Utils

object AuctionMain:
  def main(args: Array[String]): Unit =
    println("=== Auction Smart Contract Compiled ===")
    val compiled = scalus.Compiler.compile(AuctionValidator.spend)
    val program = compiled.toUplc(generateErrorTraces = true)
    val cborHex = program.plutusV3.doubleCborHex
    println(s"Plutus V3 CBOR (${cborHex.length} chars):")
    println(cborHex)
    println("\n✅ Auction Validator READY for Cardano!")

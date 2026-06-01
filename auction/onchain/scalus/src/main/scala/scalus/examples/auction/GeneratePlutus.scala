package scalus.examples.auction

import scalus.*
import com.bloxbean.cardano.client.plutus.spec.PlutusV3Script
import com.bloxbean.cardano.client.util.HexUtil

import java.io.{File, PrintWriter}
import scala.io.Source

object GeneratePlutus:
  def main(args: Array[String]): Unit =
    // Compile the multi-purpose dispatcher (`validate`), not just `spend`.
    // This produces a script that handles both Mint and Spend contexts, matching
    // the Aiken-compiled blueprint shape that off-chain code expects.
    val sir     = scalus.Compiler.compile(AuctionValidator.validate)
    val program = sir.toUplc(generateErrorTraces = true)
    val uplc    = program.plutusV3

    // Two different encodings for two different consumers:
    //   * `doubleCborHex` (CBOR-of-CBOR-of-flat) is what `PlutusV3Script.builder`
    //     expects, so the script hash is computed from that.
    //   * `cborEncoded` (single CBOR layer wrapping the flat UPLC) is what goes
    //     into the blueprint's `compiledCode` field — off-chain libraries
    //     re-wrap it in CBOR when building the script. Writing the double form
    //     here yields "TooMuchSpace" at deserialisation time on chain.
    //     payment-splitter's `GenUplc.scala` is the working reference.
    val doubleCborHex   = uplc.doubleCborHex
    val singleCborHex   = HexUtil.encodeHexString(uplc.cborEncoded)

    val script     = PlutusV3Script.builder().cborHex(doubleCborHex).build()
    val scriptHash = HexUtil.encodeHexString(script.getScriptHash)

    val template = readResource("/plutus.json.template")
    val output   = template.replace("$compiledCode", singleCborHex).replace("$hash", scriptHash)
    writeFile("plutus.json", output)
    println(s"plutus.json written (hash=$scriptHash)")

  private def readResource(path: String): String =
    val is = getClass.getResourceAsStream(path)
    if is == null then throw new RuntimeException(s"Resource not found: $path")
    try Source.fromInputStream(is).mkString finally is.close()

  private def writeFile(name: String, content: String): Unit =
    val w = new PrintWriter(new File(name))
    try w.write(content) finally w.close()
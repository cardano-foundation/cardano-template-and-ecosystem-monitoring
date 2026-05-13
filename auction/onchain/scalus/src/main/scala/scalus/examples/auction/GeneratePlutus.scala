package scalus.examples.auction

import scalus.*
import com.bloxbean.cardano.client.plutus.spec.PlutusV3Script
import com.bloxbean.cardano.client.util.HexUtil

import java.io.{File, PrintWriter}
import scala.io.Source

object GeneratePlutus:
  def main(args: Array[String]): Unit =
    val sir     = scalus.Compiler.compile(AuctionValidator.spend)
    val program = sir.toUplc(generateErrorTraces = true)
    val doubleCborHex = program.plutusV3.doubleCborHex

    val script     = PlutusV3Script.builder().cborHex(doubleCborHex).build()
    val scriptHash = HexUtil.encodeHexString(script.getScriptHash)

    val template = readResource("/plutus.json.template")
    val output   = template.replace("$compiledCode", doubleCborHex).replace("$hash", scriptHash)
    writeFile("plutus.json", output)
    println(s"plutus.json written (hash=$scriptHash)")

  private def readResource(path: String): String =
    val is = getClass.getResourceAsStream(path)
    if is == null then throw new RuntimeException(s"Resource not found: $path")
    try Source.fromInputStream(is).mkString finally is.close()

  private def writeFile(name: String, content: String): Unit =
    val w = new PrintWriter(new File(name))
    try w.write(content) finally w.close()
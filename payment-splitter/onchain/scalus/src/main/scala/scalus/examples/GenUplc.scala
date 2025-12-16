package scalus.examples


import scalus.*
import com.bloxbean.cardano.client.plutus.spec.{PlutusV2Script, PlutusV3Script}
import com.bloxbean.cardano.client.util.HexUtil
import scalus.uplc.DeBruijnedProgram

import scala.io.Source

object GenUplc {

    def main(args: Array[String]): Unit = {
        val sir = PaymentSplitter.sir
        //println(sir.pretty.render(100))
        val uplc = sir.toUplcOptimized().plutusV3
        //println(uplc.pretty.render(100))
        val doubleCboxHex = uplc.doubleCborHex
        //val hex =  uplc.flatEncoded
        val script = PlutusV3Script.builder().cborHex(doubleCboxHex).build()
        val scriptHash = HexUtil.encodeHexString(script.getScriptHash)

        val hex = HexUtil.encodeHexString(uplc.cborEncoded)
        //val uplc1 = DeBruijnedProgram.fromCborHex(hex).toProgram
        //  use template from aiken while have no own blueprints yet.
        val fname = "/plutus.json.template"
        val template = readTemplate(fname)
        val output = template.replace("$compiledCode",hex).replace("$hash",scriptHash)
        writeFile("plutus.json", output)
    }

    private def readTemplate(fname: String): String = {
        val inputStream = this.getClass.getResourceAsStream(fname)
        if inputStream == null then
            throw new RuntimeException(s"Resource not found: $fname")
        try
            Source.fromInputStream(inputStream).mkString
        finally
            inputStream.close()
    }

    private def writeFile(fname: String, content: String): Unit = {
        val writer = new java.io.PrintWriter(fname)
        try
            writer.write(content)
        finally
            writer.close()
    }

}

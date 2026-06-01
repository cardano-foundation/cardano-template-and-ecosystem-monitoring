package scalus.examples.auction

import scalus.*
import utest.*
import scalus.builtin.ByteString.{hex, utf8}
import scalus.ledger.api.v3.PubKeyHash

object AuctionValidatorTests extends TestSuite:
  val tests = Tests {
    test("compiles") {
      val datum = AuctionDatum(
        PubKeyHash(hex"00000000000000000000000000000000000000000000000000000000"),
        PubKeyHash(hex"00000000000000000000000000000000000000000000000000000000"),
        3000000L,
        1753939940L,
        utf8"policy123",
        utf8"auction_nft"
      )
      assert(datum.highest_bid == 3000000L)
    }
  }

import { describe, expect, test } from "bun:test"
import { parseToncenterTransaction } from "../src/lib/communities/commerce/funding-source/ton-testnet-confirm-runtime"

// Regression fixture for the toncenter v3 GET /transactions response, shaped per the documented
// schema (top-level { transactions: [...] }; in_msg.destination / in_msg.value; text comment at
// in_msg.message_content.decoded.comment when decoded.type === "text_comment").
//
// >>> TODO(live-validation): replace/augment with a REAL captured response. Make one TON testnet
// transfer to PIRATE_TON_TESTNET_RECIPIENT with comment `pirate-spend:<intentId>`, then capture:
//   curl 'https://testnet.toncenter.com/api/v3/transactions?hash=<TX_HASH>&limit=1' \
//     -H 'X-API-Key: <KEY>' > toncenter-tx.json
// Paste its JSON below and confirm this test still passes; adjust parseToncenterTransaction if not.
const DOCUMENTED_SHAPE_RESPONSE = {
  transactions: [
    {
      hash: "abc123",
      in_msg: {
        source: "EQsender_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        destination: "EQrecipient_test",
        value: "1500000000",
        message_content: {
          hash: "P+k4lxWGmOTUc7dEFNdJNxaw/DpwMQk0hz8AGdqsyrQ=",
          body: "te6cckEBAQEABgAACAAAAADjAK8P",
          decoded: { type: "text_comment", comment: "pirate-spend:spi_fixture" },
        },
      },
    },
  ],
}

describe("toncenter v3 transaction parsing", () => {
  test("extracts destination, nanoton value, and the text comment", () => {
    const tx = parseToncenterTransaction(DOCUMENTED_SHAPE_RESPONSE, "abc123")
    expect(tx).toEqual({
      hash: "abc123",
      toAddress: "EQrecipient_test",
      amountNano: "1500000000",
      payload: "pirate-spend:spi_fixture",
    })
  })

  test("a non-text-comment decoded body yields a null payload (never trusted as a memo)", () => {
    const response = {
      transactions: [
        {
          in_msg: {
            destination: "EQrecipient_test",
            value: "1000000000",
            message_content: { decoded: { type: "binary", data: "deadbeef" } },
          },
        },
      ],
    }
    const tx = parseToncenterTransaction(response, "h")
    expect(tx?.payload).toBeNull()
    expect(tx?.toAddress).toBe("EQrecipient_test")
  })

  test("empty / mismatched responses parse to null (resolver treats as pending)", () => {
    expect(parseToncenterTransaction({ transactions: [] }, "h")).toBeNull()
    expect(parseToncenterTransaction({}, "h")).toBeNull()
    expect(parseToncenterTransaction(null, "h")).toBeNull()
    // Missing destination -> null.
    expect(parseToncenterTransaction({ transactions: [{ in_msg: { value: "1" } }] }, "h")).toBeNull()
  })

  test("a numeric value is coerced to a string nanoton amount", () => {
    const response = { transactions: [{ in_msg: { destination: "EQx", value: 12345 } }] }
    expect(parseToncenterTransaction(response, "h")?.amountNano).toBe("12345")
  })
})

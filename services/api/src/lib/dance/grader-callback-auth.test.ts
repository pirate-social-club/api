import { describe, expect, test } from "bun:test"

import {
  signDanceGraderRequest,
  verifyDanceGraderCallback,
} from "./grader-callback-auth"

const body = Buffer.from('{"outcome":"failed","reason":"multiple_people","subject":"dcr_1"}')
const path = "/dance-choreographies/revisions/dcr_1/reference-callback"
const key = "callback-secret-at-least-32-bytes"

describe("dance grader callback authentication", () => {
  test("accepts the Modal service-protocol signature shape", () => {
    const signature = signDanceGraderRequest({
      key,
      method: "POST",
      path,
      timestamp: 1000,
      subject: "dcr_1",
      body,
    })
    expect(() => verifyDanceGraderCallback({
      env: {
        DANCE_GRADER_CALLBACK_HMAC_KEY: key,
        DANCE_GRADER_CALLBACK_KEY_VERSION: "v1",
      },
      method: "POST",
      path,
      timestampHeader: "1000",
      keyVersionHeader: "v1",
      signatureHeader: signature,
      subject: "dcr_1",
      body,
      nowSeconds: 1100,
    })).not.toThrow()
  })

  test("rejects a stale timestamp, wrong path, or wrong key version", () => {
    const signature = signDanceGraderRequest({
      key,
      method: "POST",
      path,
      timestamp: 1000,
      subject: "dcr_1",
      body,
    })
    for (const override of [
      { nowSeconds: 1301 },
      { path: `${path}/wrong` },
      { keyVersionHeader: "v2" },
    ]) {
      expect(() => verifyDanceGraderCallback({
        env: {
          DANCE_GRADER_CALLBACK_HMAC_KEY: key,
          DANCE_GRADER_CALLBACK_KEY_VERSION: "v1",
        },
        method: "POST",
        path,
        timestampHeader: "1000",
        keyVersionHeader: "v1",
        signatureHeader: signature,
        subject: "dcr_1",
        body,
        nowSeconds: 1100,
        ...override,
      })).toThrow("Authentication failed")
    }
  })
})

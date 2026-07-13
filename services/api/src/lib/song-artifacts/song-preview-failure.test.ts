import { describe, expect, test } from "bun:test"
import {
  badRequestError,
  providerUnavailable,
  songContentHashMismatchError,
} from "../errors"
import { permanentPreviewFailure } from "./song-preview-failure"

describe("permanentPreviewFailure", () => {
  test("preserves the code and status of a content hash mismatch", () => {
    const failure = permanentPreviewFailure(
      songContentHashMismatchError("Primary audio content hash does not match downloaded bytes", {
        source_content_hash: "0xaaa",
        upload_content_hash: "0xbbb",
      }),
    )

    // Collapsing this into a 502 would make a permanent integrity fault look like a
    // transient container outage, and the caller would retry it forever.
    expect(failure).toMatchObject({
      code: "song_content_hash_mismatch",
      status: 422,
    })
    expect(failure?.details).toMatchObject({ upload_content_hash: "0xbbb" })
  })

  test("classifies other deterministic client faults as permanent", () => {
    expect(permanentPreviewFailure(badRequestError("Bundle has no preview window"))).toMatchObject({
      code: "bad_request",
      status: 400,
    })
  })

  test("leaves transient provider failures retryable", () => {
    expect(permanentPreviewFailure(providerUnavailable("ffmpeg worker unavailable"))).toBeNull()
    expect(permanentPreviewFailure(new Error("socket hang up"))).toBeNull()
  })
})

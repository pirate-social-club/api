import { describe, expect, test } from "bun:test"
import {
  decodePublicNamespaceVerificationId,
  decodePublicNamespaceVerificationSessionId,
} from "../src/lib/public-ids"

describe("public namespace IDs", () => {
  test("namespace verification IDs accept raw, public, and repeatedly-prefixed values", () => {
    expect(decodePublicNamespaceVerificationId("nv_abc123")).toBe("nv_abc123")
    expect(decodePublicNamespaceVerificationId("nv_nv_abc123")).toBe("nv_abc123")
    expect(decodePublicNamespaceVerificationId("nv_nv_nv_abc123")).toBe("nv_abc123")
  })

  test("namespace verification session IDs accept raw, public, and repeatedly-prefixed values", () => {
    expect(decodePublicNamespaceVerificationSessionId("nvs_abc123")).toBe("nvs_abc123")
    expect(decodePublicNamespaceVerificationSessionId("nvs_nvs_abc123")).toBe("nvs_abc123")
    expect(decodePublicNamespaceVerificationSessionId("nvs_nvs_nvs_abc123")).toBe("nvs_abc123")
  })
})

import { describe, expect, test } from "bun:test"
import {
  decodePublicNamespaceVerificationId,
  decodePublicNamespaceVerificationSessionId,
  publicId,
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

  test("audited public ID families emit exactly one type prefix", () => {
    expect(publicId("agt_operator", "agt")).toBe("agt_operator")
    expect(publicId("nv_operator", "nv")).toBe("nv_operator")
    expect(publicId("usr_operator", "usr")).toBe("usr_operator")
    expect(publicId("  usr_usr_operator  ", "usr")).toBe("usr_operator")
  })

  test("unaudited and single-strip families retain the historical representation", () => {
    expect(publicId("cmt_comment", "cmt")).toBe("cmt_cmt_comment")
    expect(publicId("nvs_session", "nvs")).toBe("nvs_nvs_session")
    expect(publicId("sab_bundle", "sab")).toBe("sab_sab_bundle")
    expect(publicId("sau_upload", "sau")).toBe("sau_sau_upload")
    expect(publicId("lst_gate", "lst")).toBe("lst_lst_gate")
    expect(publicId("aor_record", "aor")).toBe("aor_aor_record")
  })
})

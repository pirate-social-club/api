import { createClient } from "@libsql/client"
import { describe, expect, test } from "bun:test"
import { supersedePromotedLocalMirror } from "./namespace-local-repository"

describe("supersedePromotedLocalMirror", () => {
  test("retires the active mirror before the recovered verification becomes primary", async () => {
    const client = createClient({ url: ":memory:" })
    await client.execute(`
      CREATE TABLE namespace_bindings (
        namespace_id TEXT PRIMARY KEY,
        community_id TEXT NOT NULL,
        namespace_verification_id TEXT NOT NULL,
        namespace_role TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
    await client.execute(`
      CREATE UNIQUE INDEX idx_namespace_bindings_active_verification
      ON namespace_bindings(namespace_verification_id)
      WHERE status = 'active'
    `)
    await client.execute(`
      INSERT INTO namespace_bindings VALUES
        ('ns_cmt_1', 'cmt_1', 'nv_old', 'primary', 'active', 'old'),
        ('ns_nv_new', 'cmt_1', 'nv_new', 'mirror', 'active', 'old')
    `)

    await supersedePromotedLocalMirror(client, {
      communityId: "cmt_1",
      namespaceVerificationId: "nv_new",
      primaryNamespaceId: "ns_cmt_1",
      updatedAt: "new",
    })
    await client.execute(`
      UPDATE namespace_bindings
      SET namespace_verification_id = 'nv_new', updated_at = 'new'
      WHERE namespace_id = 'ns_cmt_1'
    `)

    const rows = await client.execute(`
      SELECT namespace_id, namespace_verification_id, namespace_role, status
      FROM namespace_bindings ORDER BY namespace_id
    `)
    expect(rows.rows).toEqual([
      expect.objectContaining({
        namespace_id: "ns_cmt_1",
        namespace_verification_id: "nv_new",
        namespace_role: "primary",
        status: "active",
      }),
      expect.objectContaining({
        namespace_id: "ns_nv_new",
        namespace_verification_id: "nv_new",
        namespace_role: "mirror",
        status: "superseded",
      }),
    ])
    client.close()
  })
})

import { createClient } from "@libsql/client"
import { describe, expect, test } from "bun:test"
import {
  reconcileCommittedLocalNamespaceAttachment,
  writeLocalNamespaceAttachment,
} from "./namespace-local-repository"

describe("reconcileCommittedLocalNamespaceAttachment", () => {
  test("reports a post-commit projection failure without rejecting the committed mutation", async () => {
    const failure = new Error("local projection failed")
    let observed: unknown = null

    const reconciled = await reconcileCommittedLocalNamespaceAttachment(
      async () => { throw failure },
      (error) => { observed = error },
    )

    expect(reconciled).toBe(false)
    expect(observed).toBe(failure)
  })
})

describe("writeLocalNamespaceAttachment", () => {
  test("retires the active mirror before the recovered verification becomes primary", async () => {
    const client = createClient({ url: ":memory:" })
    await client.execute(`
      CREATE TABLE namespace_bindings (
        namespace_id TEXT PRIMARY KEY,
        community_id TEXT NOT NULL,
        namespace_verification_id TEXT NOT NULL,
        display_label TEXT NOT NULL,
        normalized_label TEXT NOT NULL,
        resolver_label TEXT,
        route_family TEXT,
        namespace_role TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
    await client.execute(`
      CREATE TABLE namespace_handle_policies (
        namespace_handle_policy_id TEXT PRIMARY KEY,
        community_id TEXT NOT NULL,
        namespace_id TEXT NOT NULL,
        policy_template TEXT NOT NULL,
        pricing_model TEXT,
        membership_required_for_claim INTEGER NOT NULL,
        claims_enabled INTEGER NOT NULL,
        settings_json TEXT,
        created_at TEXT NOT NULL,
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
        ('ns_cmt_1', 'cmt_1', 'nv_old', 'dankmeme', 'dankmeme', NULL, NULL,
          'primary', 'active', 'old', 'old'),
        ('ns_nv_new', 'cmt_1', 'nv_new', 'dankmeme', 'dankmeme', NULL, NULL,
          'mirror', 'active', 'old', 'old')
    `)

    await writeLocalNamespaceAttachment(client, {
      communityId: "cmt_1",
      namespaceVerificationId: "nv_new",
      namespaceRole: "primary",
      namespaceLabel: "dankmeme",
      now: "new",
    })

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

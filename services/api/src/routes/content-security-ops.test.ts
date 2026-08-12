import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import type { Env } from "../env"
import { createControlPlaneTestClient } from "../../tests/helpers"
import {
  activateContentSecurityScannerRelease,
  revokeContentSecurityScannerRelease,
  stageContentSecurityScannerRelease,
  type StageContentSecurityScannerReleaseInput,
} from "../lib/content-security/content-security-release-service"
import {
  BOOKING_SETTLEMENT_RESOLVE_SCOPE,
  CONTENT_SECURITY_SCANNER_RELEASE_MANAGE_SCOPE,
} from "../lib/operator-credential-auth"
import type { Client } from "../lib/sql-client"
import contentSecurityOps, { setContentSecurityOpsDependenciesForTests } from "./content-security-ops"

const NOW = "2026-08-13T00:00:00.000Z"
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  setContentSecurityOpsDependenciesForTests({})
  while (cleanups.length > 0) await cleanups.pop()?.()
})

function identity(suffix: string): Omit<StageContentSecurityScannerReleaseInput, "actorId" | "authorizationRef" | "reason" | "now"> {
  return {
    securityScanProfile: "clamav-text-v1",
    sourceRevision: `revision-${suffix}`,
    runtimeLockSha256: "a".repeat(64),
    baseImageDigest: `sha256:${"b".repeat(64)}`,
    engineImageDigest: `sha256:${"c".repeat(64)}`,
    engineVersion: "1.5.4",
    signatureVersion: `signatures-${suffix}`,
    signatureDate: NOW,
    definitionDigest: "d".repeat(64),
    deployedImageDigest: `sha256:${(suffix === "one" ? "e" : "f").repeat(64)}`,
    sbomRef: `sbom://${suffix}`,
    corpusEvidenceRef: `evidence://corpus/${suffix}`,
  }
}

function stageInput(suffix: string, now = NOW): StageContentSecurityScannerReleaseInput {
  return {
    ...identity(suffix),
    actorId: "scanner-release-operator",
    authorizationRef: `change:${suffix}`,
    reason: `Promote verified corpus ${suffix}`,
    now,
  }
}

async function database() {
  const fixture = await createControlPlaneTestClient({ includeAllMigrations: true })
  cleanups.push(fixture.cleanup)
  return fixture
}

describe("content security scanner release lifecycle", () => {
  test("stages idempotently, rotates the active release, and revokes terminally", async () => {
    const fixture = await database()
    const client = fixture.client as unknown as Client
    const first = await stageContentSecurityScannerRelease(client, stageInput("one"))
    expect(first.status).toBe("staged")
    expect((await stageContentSecurityScannerRelease(client, stageInput("one"))).scannerReleaseId)
      .toBe(first.scannerReleaseId)
    expect((await activateContentSecurityScannerRelease(client, {
      scannerReleaseId: first.scannerReleaseId,
      actorId: "scanner-release-operator",
      authorizationRef: "change:activate-one",
      reason: "Corpus and deployment evidence accepted",
      now: "2026-08-13T00:01:00.000Z",
    })).status).toBe("active")

    const second = await stageContentSecurityScannerRelease(
      client,
      stageInput("two", "2026-08-13T00:02:00.000Z"),
    )
    expect((await activateContentSecurityScannerRelease(client, {
      scannerReleaseId: second.scannerReleaseId,
      actorId: "scanner-release-operator",
      authorizationRef: "change:activate-two",
      reason: "New signature bundle passed the corpus",
      now: "2026-08-13T00:03:00.000Z",
    })).status).toBe("active")

    const releases = await fixture.client.execute({
      sql: `SELECT scanner_release_id, status FROM content_security_scanner_releases ORDER BY created_at`,
      args: [],
    })
    expect(releases.rows).toEqual([
      expect.objectContaining({ scanner_release_id: first.scannerReleaseId, status: "retired" }),
      expect.objectContaining({ scanner_release_id: second.scannerReleaseId, status: "active" }),
    ])
    expect((await revokeContentSecurityScannerRelease(client, {
      scannerReleaseId: first.scannerReleaseId,
      actorId: "scanner-release-operator",
      authorizationRef: "incident:retired-release",
      reason: "Later evidence invalidated the retired definition bundle",
      now: "2026-08-13T00:04:00.000Z",
    })).status).toBe("revoked")

    const audits = await fixture.client.execute({
      sql: `SELECT action FROM audit_log WHERE target_type = 'content_security_scanner_release' ORDER BY created_at`,
      args: [],
    })
    expect(audits.rows.map((row) => row.action)).toEqual([
      "content_security.scanner_release_stage",
      "content_security.scanner_release_activate",
      "content_security.scanner_release_stage",
      "content_security.scanner_release_activate",
      "content_security.scanner_release_revoke",
    ])
  })

  test("rejects a staged release without fabricating activation", async () => {
    const fixture = await database()
    const client = fixture.client as unknown as Client
    const staged = await stageContentSecurityScannerRelease(client, stageInput("one"))
    const revoked = await revokeContentSecurityScannerRelease(client, {
      scannerReleaseId: staged.scannerReleaseId,
      actorId: "scanner-release-operator",
      authorizationRef: "corpus:failure",
      reason: "Malicious fixture was not detected",
      now: "2026-08-13T00:01:00.000Z",
    })
    expect(revoked).toMatchObject({ status: "revoked", activatedAt: null })
    expect(revoked.retiredAt).not.toBeNull()
    await expect(activateContentSecurityScannerRelease(client, {
      scannerReleaseId: staged.scannerReleaseId,
      actorId: "scanner-release-operator",
      authorizationRef: "invalid:rollback",
      reason: "Must remain impossible",
      now: "2026-08-13T00:02:00.000Z",
    })).rejects.toThrow("Only a staged")
  })
})

function app() {
  const value = new Hono<{ Bindings: Env }>()
  value.onError((error, c) => c.json({ error: error.message }, ((error as { status?: number }).status ?? 500) as 400))
  value.route("/operator/content-security", contentSecurityOps)
  return value
}

function requestBody() {
  return {
    security_scan_profile: "clamav-text-v1",
    source_revision: "revision-route",
    runtime_lock_sha256: "a".repeat(64),
    base_image_digest: `sha256:${"b".repeat(64)}`,
    engine_image_digest: `sha256:${"c".repeat(64)}`,
    engine_version: "1.5.4",
    signature_version: "signatures-route",
    signature_date: NOW,
    definition_digest: "d".repeat(64),
    deployed_image_digest: `sha256:${"e".repeat(64)}`,
    sbom_ref: "sbom://route",
    corpus_evidence_ref: "evidence://corpus/route",
    authorization_ref: "change:route",
    reason: "Route fixture passed the corpus",
  }
}

describe("content security scanner release operator routes", () => {
  test("requires the dedicated scope before calling the lifecycle service", async () => {
    let staged = false
    setContentSecurityOpsDependenciesForTests({
      authenticate: async () => ({
        authType: "operator_credential",
        operatorCredentialId: "opc_fixture",
        operatorActorId: "scanner-release-operator",
        scopes: [BOOKING_SETTLEMENT_RESOLVE_SCOPE],
      }),
      stage: async () => { staged = true; throw new Error("must not run") },
    })
    const response = await app().request("/operator/content-security/scanner-releases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody()),
    }, {} as Env)
    expect(response.status).toBe(403)
    expect(staged).toBe(false)
  })

  test("strictly parses and serializes a staged release without cacheable responses", async () => {
    const fixture = await database()
    setContentSecurityOpsDependenciesForTests({
      authenticate: async () => ({
        authType: "operator_credential",
        operatorCredentialId: "opc_fixture",
        operatorActorId: "scanner-release-operator",
        scopes: [CONTENT_SECURITY_SCANNER_RELEASE_MANAGE_SCOPE],
      }),
      getClient: () => fixture.client as unknown as Client,
      now: () => NOW,
    })
    const extra = await app().request("/operator/content-security/scanner-releases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...requestBody(), unknown: true }),
    }, {} as Env)
    expect(extra.status).toBe(400)

    const response = await app().request("/operator/content-security/scanner-releases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody()),
    }, {} as Env)
    expect(response.status).toBe(201)
    expect(response.headers.get("cache-control")).toContain("no-store")
    expect(await response.json()).toEqual(expect.objectContaining({
      id: expect.stringMatching(/^csr_[a-f0-9]{32}$/),
      object: "content_security_scanner_release",
      status: "staged",
      created: Date.parse(NOW) / 1000,
      activated_at: null,
    }))
  })

  test("rejects malformed release ids before lifecycle mutation", async () => {
    let revoked = false
    setContentSecurityOpsDependenciesForTests({
      authenticate: async () => ({
        authType: "operator_credential",
        operatorCredentialId: "opc_fixture",
        operatorActorId: "scanner-release-operator",
        scopes: [CONTENT_SECURITY_SCANNER_RELEASE_MANAGE_SCOPE],
      }),
      revoke: async () => { revoked = true; throw new Error("must not run") },
    })
    const response = await app().request(
      "/operator/content-security/scanner-releases/not-a-release/revoke",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          authorization_ref: "incident:invalid-route",
          reason: "Malformed route input",
        }),
      },
      {} as Env,
    )
    expect(response.status).toBe(400)
    expect(revoked).toBe(false)
  })
})

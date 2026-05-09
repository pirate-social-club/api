import { describe, expect, test } from "bun:test"
import { rmSync, readFileSync, writeFileSync } from "node:fs"
import { mkdtempSync } from "node:fs"
import { basename, join } from "node:path"
import { tmpdir } from "node:os"
import { parseArgs } from "./args.js"
import { readSeedAccounts, writeSeedAccounts } from "./config.js"
import { getFlag, requireFlag } from "./args.js"
import {
  assertExecutableNamespaceVerificationId,
  buildConventionalFolderPlan,
  buildJsonManifestPlan,
  buildManifestPlan,
  buildSelfNationalityGatePayload,
  parseSimpleYaml,
} from "./commands/community.js"
import { buildSeedPostBodyFromArgs } from "./seed-post-body.js"

describe("CLI payload builders", () => {
  test("--self-nationality builds correct gate payload for 2-letter code", () => {
    const payload = buildSelfNationalityGatePayload("PSE")
    expect(payload).toEqual({
      membership_mode: "gated",
      default_age_gate_policy: "none",
      allow_anonymous_identity: false,
      gate_rules: [{
        scope: "membership",
        gate_family: "identity_proof",
        gate_type: "nationality",
        proof_requirements: [{
          proof_type: "nationality",
          accepted_providers: ["self"],
          config: { required_value: "PSE" },
        }],
      }],
    })
  })

  test("--self-nationality builds correct gate payload for 3-letter code", () => {
    const payload = buildSelfNationalityGatePayload("PAL")
    const rules = payload.gate_rules as Array<{ proof_requirements: Array<{ config: { required_value: string } }> }>
    expect(rules[0].proof_requirements[0].config.required_value).toBe("PAL")
    expect(payload.membership_mode).toBe("gated")
  })

  test("--self-nationality lowercases and uppercases input", () => {
    const payload = buildSelfNationalityGatePayload("pse")
    const rules = payload.gate_rules as Array<{ proof_requirements: Array<{ config: { required_value: string } }> }>
    expect(rules[0].proof_requirements[0].config.required_value).toBe("PSE")
  })

  test("--self-nationality rejects invalid codes", () => {
    expect(() => buildSelfNationalityGatePayload("X")).toThrow()
    expect(() => buildSelfNationalityGatePayload("TOOLONG")).toThrow()
  })
})

describe("seed accounts resolution", () => {
  test("reads seed accounts from file", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pirate-cli-test-"))
    const accountsPath = join(tmpDir, "seed-accounts.json")
    writeFileSync(accountsPath, JSON.stringify({
      editorial: "usr_abc123",
      curator: "usr_def456",
    }))

    const accounts = readSeedAccounts(accountsPath)
    expect(accounts.editorial).toBe("usr_abc123")
    expect(accounts.curator).toBe("usr_def456")

    rmSync(tmpDir, { recursive: true, force: true })
  })

  test("returns empty when file does not exist", () => {
    const accounts = readSeedAccounts("/nonexistent/path/seed-accounts.json")
    expect(accounts).toEqual({})
  })

  test("throws on invalid JSON", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pirate-cli-test-"))
    const accountsPath = join(tmpDir, "seed-accounts.json")
    writeFileSync(accountsPath, "not json")

    expect(() => readSeedAccounts(accountsPath)).toThrow()

    rmSync(tmpDir, { recursive: true, force: true })
  })

  test("reads string and metadata seed account entries", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pirate-cli-test-"))
    const accountsPath = join(tmpDir, "seed-accounts.json")
    writeFileSync(accountsPath, JSON.stringify({
      valid: "usr_123",
      metadata: {
        user_id: "usr_456",
        provider: "bot_wallet",
        communities: ["@example"],
      },
      invalid: 42,
      also_invalid: null,
    }))

    const accounts = readSeedAccounts(accountsPath)
    expect(accounts).toEqual({ valid: "usr_123", metadata: "usr_456" })

    rmSync(tmpDir, { recursive: true, force: true })
  })

  test("writes seed accounts with normalized JSON", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pirate-cli-test-"))
    const accountsPath = join(tmpDir, "seed-accounts.json")

    writeSeedAccounts({ editorial: "usr_abc123" }, accountsPath)

    expect(readSeedAccounts(accountsPath)).toEqual({ editorial: "usr_abc123" })
    expect(readFileSync(accountsPath, "utf8").includes("\"editorial\": \"usr_abc123\"")).toBe(true)

    rmSync(tmpDir, { recursive: true, force: true })
  })

  test("writeSeedAccounts preserves existing metadata entries", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pirate-cli-test-"))
    const accountsPath = join(tmpDir, "seed-accounts.json")
    writeFileSync(accountsPath, JSON.stringify({
      lantern: {
        user_id: "usr_old",
        provider: "bot_wallet",
        communities: ["@xn--t77hga"],
      },
    }))

    writeSeedAccounts({ lantern: "usr_new", velvet: "usr_velvet" }, accountsPath)

    const raw = JSON.parse(readFileSync(accountsPath, "utf8")) as Record<string, unknown>
    expect(raw.lantern).toEqual({
      user_id: "usr_new",
      provider: "bot_wallet",
      communities: ["@xn--t77hga"],
    })
    expect(raw.velvet).toBe("usr_velvet")

    rmSync(tmpDir, { recursive: true, force: true })
  })
})

describe("CLI args parsing for admin commands", () => {
  test("parses community gates set args with --self-nationality", () => {
    const args = parseArgs(["community", "gates", "set", "@foo", "--self-nationality", "PSE"])
    expect(args.positionals).toEqual(["community", "gates", "set", "@foo"])
    expect(getFlag(args, "self-nationality")).toBe("PSE")
  })

  test("parses community seed-post args", () => {
    const args = parseArgs([
      "community", "seed-post", "@foo",
      "--as", "editorial",
      "--idempotency-key", "welcome-001",
      "--post-type", "link",
      "--link-url", "https://example.com",
      "--body-file", "posts/welcome.md",
    ])
    expect(args.positionals).toEqual(["community", "seed-post", "@foo"])
    expect(getFlag(args, "as")).toBe("editorial")
    expect(getFlag(args, "idempotency-key")).toBe("welcome-001")
    expect(getFlag(args, "post-type")).toBe("link")
    expect(getFlag(args, "link-url")).toBe("https://example.com")
    expect(getFlag(args, "body-file")).toBe("posts/welcome.md")
  })

  test("parses community seed-comment args", () => {
    const args = parseArgs([
      "community", "seed-comment", "@foo", "pst_123",
      "--as", "editorial",
      "--idempotency-key", "welcome-comment-001",
      "--body-file", "comments/welcome.md",
    ])
    expect(args.positionals).toEqual(["community", "seed-comment", "@foo", "pst_123"])
    expect(getFlag(args, "as")).toBe("editorial")
    expect(getFlag(args, "idempotency-key")).toBe("welcome-comment-001")
    expect(getFlag(args, "body-file")).toBe("comments/welcome.md")
  })

  test("parses community join and follow args", () => {
    const joinArgs = parseArgs(["community", "join", "@foo", "--as", "editorial"])
    expect(joinArgs.positionals).toEqual(["community", "join", "@foo"])
    expect(getFlag(joinArgs, "as")).toBe("editorial")

    const followArgs = parseArgs(["community", "follow", "@foo", "--as-user-id", "usr_123"])
    expect(followArgs.positionals).toEqual(["community", "follow", "@foo"])
    expect(getFlag(followArgs, "as-user-id")).toBe("usr_123")
  })

  test("parses community role grant args", () => {
    const args = parseArgs([
      "community", "roles", "grant", "@foo",
      "--role", "moderator",
      "--account", "editorial",
    ])
    expect(args.positionals).toEqual(["community", "roles", "grant", "@foo"])
    expect(getFlag(args, "role")).toBe("moderator")
    expect(getFlag(args, "account")).toBe("editorial")
  })

  test("parses community account ensure args", () => {
    const args = parseArgs([
      "community", "accounts", "ensure",
      "--alias", "editorial",
      "--subject", "launch-editorial-001",
      "--display-name", "Editorial",
      "--handle", "editorial",
    ])
    expect(args.positionals).toEqual(["community", "accounts", "ensure"])
    expect(getFlag(args, "alias")).toBe("editorial")
    expect(getFlag(args, "subject")).toBe("launch-editorial-001")
    expect(getFlag(args, "display-name")).toBe("Editorial")
    expect(getFlag(args, "handle")).toBe("editorial")
  })

  test("parses community members and provision-batch args", () => {
    const membersArgs = parseArgs(["community", "members", "@xn--t77hga"])
    expect(membersArgs.positionals).toEqual(["community", "members", "@xn--t77hga"])

    const batchArgs = parseArgs([
      "community", "accounts", "provision-batch",
      "--file", "accounts.json",
      "--accounts-file", "seed-accounts.json",
    ])
    expect(batchArgs.positionals).toEqual(["community", "accounts", "provision-batch"])
    expect(getFlag(batchArgs, "file")).toBe("accounts.json")
    expect(getFlag(batchArgs, "accounts-file")).toBe("seed-accounts.json")
  })

  test("parses post and comment vote args", () => {
    const postArgs = parseArgs(["post", "vote", "pst_123", "--value", "1", "--as", "editorial"])
    expect(postArgs.positionals).toEqual(["post", "vote", "pst_123"])
    expect(getFlag(postArgs, "value")).toBe("1")
    expect(getFlag(postArgs, "as")).toBe("editorial")

    const commentArgs = parseArgs(["comment", "vote", "com_123", "--value", "-1", "--as-user-id", "usr_123"])
    expect(commentArgs.positionals).toEqual(["comment", "vote", "com_123"])
    expect(getFlag(commentArgs, "value")).toBe("-1")
    expect(getFlag(commentArgs, "as-user-id")).toBe("usr_123")
  })

  test("parses profile update args", () => {
    const args = parseArgs(["profile", "update", "--as", "editorial", "--display-name", "Editor", "--bio-file", "profiles/editor.md"])
    expect(args.positionals).toEqual(["profile", "update"])
    expect(getFlag(args, "as")).toBe("editorial")
    expect(getFlag(args, "display-name")).toBe("Editor")
    expect(getFlag(args, "bio-file")).toBe("profiles/editor.md")
  })

  test("parses auth admin-login args", () => {
    const args = parseArgs([
      "auth", "admin-login",
      "--admin-token", "secret",
      "--as-user", "usr_123",
      "--base-url", "https://api.pirate.sc",
    ])
    expect(args.positionals).toEqual(["auth", "admin-login"])
    expect(getFlag(args, "admin-token")).toBe("secret")
    expect(getFlag(args, "as-user")).toBe("usr_123")
    expect(getFlag(args, "base-url")).toBe("https://api.pirate.sc")
  })

  test("parses community lookup with @-prefixed slug", () => {
    const args = parseArgs(["community", "lookup", "@xn--t77hga"])
    expect(args.positionals).toEqual(["community", "lookup", "@xn--t77hga"])
  })

  test("requireFlag throws for missing flag", () => {
    const args = parseArgs(["community", "seed-post", "@foo"])
    expect(() => requireFlag(args, "idempotency-key")).toThrow("Missing required flag --idempotency-key")
  })
})

describe("seed post payload builder", () => {
  test("builds text seed post payloads", () => {
    const args = parseArgs([
      "community", "seed-post", "@foo",
      "--idempotency-key", "text-001",
      "--title", "Welcome",
      "--body", "Hello",
    ])

    expect(buildSeedPostBodyFromArgs(args)).toEqual({
      post_type: "text",
      identity_mode: "public",
      visibility: "public",
      idempotency_key: "text-001",
      title: "Welcome",
      body: "Hello",
    })
  })

  test("builds link seed post payloads", () => {
    const args = parseArgs([
      "community", "seed-post", "@foo",
      "--idempotency-key", "link-001",
      "--post-type", "link",
      "--title", "Read this",
      "--body", "Useful context",
      "--link-url", "https://example.com/story",
    ])

    expect(buildSeedPostBodyFromArgs(args)).toEqual({
      post_type: "link",
      identity_mode: "public",
      visibility: "public",
      idempotency_key: "link-001",
      title: "Read this",
      body: "Useful context",
      link_url: "https://example.com/story",
    })
  })

  test("builds image seed post payloads", () => {
    const args = parseArgs([
      "community", "seed-post", "@foo",
      "--idempotency-key", "image-001",
      "--post-type", "image",
      "--title", "Launch image",
      "--caption", "First image",
      "--media-ref", "community-media/post_image/example.png",
      "--mime-type", "image/png",
      "--width", "1200",
      "--height", "800",
    ])

    expect(buildSeedPostBodyFromArgs(args)).toEqual({
      post_type: "image",
      identity_mode: "public",
      visibility: "public",
      idempotency_key: "image-001",
      title: "Launch image",
      caption: "First image",
      media_refs: [{
        storage_ref: "community-media/post_image/example.png",
        mime_type: "image/png",
        width: 1200,
        height: 800,
      }],
    })
  })

  test("builds video seed post payloads", () => {
    const args = parseArgs([
      "community", "seed-post", "@foo",
      "--idempotency-key", "video-001",
      "--post-type", "video",
      "--title", "Launch video",
      "--media-ref", "community-media/post_video/example.mp4",
      "--mime-type", "video/mp4",
      "--duration-ms", "42000",
      "--poster-ref", "community-media/post_image/poster.png",
      "--poster-mime-type", "image/png",
      "--access-mode", "public",
    ])

    expect(buildSeedPostBodyFromArgs(args)).toEqual({
      post_type: "video",
      identity_mode: "public",
      visibility: "public",
      idempotency_key: "video-001",
      title: "Launch video",
      media_refs: [{
        storage_ref: "community-media/post_video/example.mp4",
        mime_type: "video/mp4",
        duration_ms: 42000,
        poster_ref: "community-media/post_image/poster.png",
        poster_mime_type: "image/png",
      }],
      access_mode: "public",
    })
  })

  test("builds song seed post payloads", () => {
    const args = parseArgs([
      "community", "seed-post", "@foo",
      "--idempotency-key", "song-001",
      "--post-type", "song",
      "--title", "Launch song",
      "--song-artifact-bundle-id", "sab_123",
      "--access-mode", "public",
      "--license-preset", "non-commercial",
      "--rights-basis", "original",
    ])

    expect(buildSeedPostBodyFromArgs(args)).toEqual({
      post_type: "song",
      identity_mode: "public",
      visibility: "public",
      idempotency_key: "song-001",
      title: "Launch song",
      song_artifact_bundle_id: "sab_123",
      access_mode: "public",
      license_preset: "non-commercial",
      rights_basis: "original",
    })
  })

  test("rejects image seed posts without complete media refs", () => {
    const args = parseArgs([
      "community", "seed-post", "@foo",
      "--idempotency-key", "image-001",
      "--post-type", "image",
      "--media-ref", "community-media/post_image/example.png",
    ])

    expect(() => buildSeedPostBodyFromArgs(args)).toThrow("media_ref and mime_type")
  })
})

describe("manifest parsing", () => {
  test("parses simple yaml with string values", () => {
    const result = parseSimpleYaml([
      "community_id: cmt_test123",
      "description_file: description.txt",
      'display_name: "Test Community"',
      "# comment line",
      "rules_file: rules.txt",
    ].join("\n"))

    expect(result.community_id).toBe("cmt_test123")
    expect(result.description_file).toBe("description.txt")
    expect(result.display_name).toBe("Test Community")
    expect(result.rules_file).toBe("rules.txt")
    expect(Object.keys(result)).toEqual(["community_id", "description_file", "display_name", "rules_file"])
  })

  test("parses yaml with empty values as null", () => {
    const result = parseSimpleYaml("optional_field:\nrequired_field: value")
    expect(result.optional_field).toEqual(null)
    expect(result.required_field).toBe("value")
  })

  test("parseSimpleYaml rejects unsupported yaml features", () => {
    expect(() => parseSimpleYaml("items:\n  nested: value")).toThrow("Unsupported YAML syntax")
    expect(() => parseSimpleYaml("items:\n- value")).toThrow("Unsupported YAML syntax")
    expect(() => parseSimpleYaml("description: |")).toThrow("Unsupported YAML syntax")
  })

  test("buildManifestPlan rejects unknown manifest fields", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pirate-cli-manifest-"))
    const manifestPath = join(tmpDir, "community.yaml")
    writeFileSync(manifestPath, "rulez_file: rules.txt")

    expect(() => buildManifestPlan(tmpDir, manifestPath, null)).toThrow("Unknown community.yaml field")

    rmSync(tmpDir, { recursive: true, force: true })
  })

  test("community.yaml resolves file references from folder", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pirate-cli-manifest-"))

    writeFileSync(join(tmpDir, "community.yaml"), [
      "community_id: cmt_test123",
      "description_file: description.txt",
      "rules_file: rules.txt",
      "reference_links_file: links.json",
      "labels_file: labels.json",
      "safety_file: safety.json",
      "donation_policy_file: donation.json",
    ].join("\n"))

    writeFileSync(join(tmpDir, "description.txt"), "A test community")
    writeFileSync(join(tmpDir, "rules.txt"), "Rule One\n\nFirst rule body")
    writeFileSync(join(tmpDir, "links.json"), JSON.stringify([{ platform: "web", url: "https://example.com" }]))
    writeFileSync(join(tmpDir, "labels.json"), JSON.stringify({
      label_enabled: true,
      require_label_on_top_level_posts: false,
      definitions: [{ label: "News", status: "active" }],
    }))
    writeFileSync(join(tmpDir, "safety.json"), JSON.stringify({
      adult_content_policy: { suggestive: "allow" },
    }))
    writeFileSync(join(tmpDir, "donation.json"), JSON.stringify({ donation_policy_mode: "none" }))

    const manifest = parseSimpleYaml(readFileSync(join(tmpDir, "community.yaml"), "utf8"))

    expect(manifest.community_id).toBe("cmt_test123")
    expect(typeof manifest.description_file).toBe("string")

    const description = readFileSync(join(tmpDir, manifest.description_file as string), "utf8")
    expect(description).toBe("A test community")

    const links = JSON.parse(readFileSync(join(tmpDir, manifest.reference_links_file as string), "utf8")) as unknown[]
    expect(Array.isArray(links)).toBe(true)
    expect(links.length).toBe(1)

    const labels = JSON.parse(readFileSync(join(tmpDir, manifest.labels_file as string), "utf8")) as Record<string, unknown>
    expect(labels.label_enabled).toBe(true)

    rmSync(tmpDir, { recursive: true, force: true })
  })

  test("buildManifestPlan rejects missing referenced files", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pirate-cli-manifest-"))
    const manifestPath = join(tmpDir, "community.yaml")
    writeFileSync(manifestPath, [
      "community_id: cmt_test123",
      "rules_file: missing-rules.txt",
    ].join("\n"))

    expect(() => buildManifestPlan(tmpDir, manifestPath, null)).toThrow("Manifest references missing file")

    rmSync(tmpDir, { recursive: true, force: true })
  })

  test("buildManifestPlan builds executable setting steps", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pirate-cli-manifest-"))
    const manifestPath = join(tmpDir, "community.yaml")
    writeFileSync(manifestPath, [
      "community_id: cmt_test123",
      "description_file: description.txt",
      "rules_file: rules.txt",
      "reference_links_file: links.json",
    ].join("\n"))
    writeFileSync(join(tmpDir, "description.txt"), "A test community")
    writeFileSync(join(tmpDir, "rules.txt"), "Rule One\n\nFirst rule body")
    writeFileSync(join(tmpDir, "links.json"), JSON.stringify([{ platform: "web", url: "https://example.com" }]))

    const plan = buildManifestPlan(tmpDir, manifestPath, null)
    expect(plan.communityId).toBe("cmt_test123")
    expect(plan.lookupIdentifier).toBe("cmt_test123")
    expect(plan.create).toBe(null)
    expect(plan.steps.map((step) => step.kind)).toEqual(["update", "rules", "links"])

    rmSync(tmpDir, { recursive: true, force: true })
  })

  test("buildManifestPlan builds safe create metadata from manifest", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "@pirate-cli-manifest-"))
    const manifestPath = join(tmpDir, "community.yaml")
    writeFileSync(manifestPath, [
      "route_slug: @new-community",
      "display_name: New Community",
      "namespace_verification_id: nv_test123",
      "description_file: description.txt",
      "membership_mode: gated",
      "human_verification_lane: very",
      "allow_anonymous_identity: true",
    ].join("\n"))
    writeFileSync(join(tmpDir, "description.txt"), "A new community")

    const plan = buildManifestPlan(tmpDir, manifestPath, null)
    expect(plan.communityId).toBe(null)
    expect(plan.lookupIdentifier).toBe("@new-community")
    expect(plan.create).toEqual({
      displayName: "New Community",
      description: "A new community",
      namespaceVerificationId: "nv_test123",
      membershipMode: "gated",
      governanceMode: "centralized",
      defaultAgeGatePolicy: "none",
      allowAnonymousIdentity: true,
      humanVerificationLane: "very",
      agentPostingPolicy: null,
      agentPostingScope: null,
      agentDailyPostCap: null,
      agentDailyReplyCap: null,
      acceptedAgentOwnershipProviders: null,
    })
    expect(plan.steps.map((step) => step.kind)).toEqual(["namespace", "update"])

    rmSync(tmpDir, { recursive: true, force: true })
  })

  test("buildManifestPlan attaches namespace for existing community manifests", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pirate-cli-manifest-"))
    const manifestPath = join(tmpDir, "community.yaml")
    writeFileSync(manifestPath, [
      "community_id: cmt_existing",
      "namespace_verification_id: nv_existing",
      "display_name: Existing Community",
      "human_verification_lane: very",
      "agent_posting_policy: allow",
      "agent_posting_scope: top_level_and_replies",
      "accepted_agent_ownership_providers: clawkey",
    ].join("\n"))

    const plan = buildManifestPlan(tmpDir, manifestPath, null)
    expect(plan.communityId).toBe("cmt_existing")
    expect(plan.lookupIdentifier).toBe("cmt_existing")
    expect(plan.create).toBe(null)
    expect(plan.steps.map((step) => step.kind)).toEqual(["namespace", "update"])
    expect(plan.steps[1]?.kind === "update" ? plan.steps[1].body : null).toEqual({
      display_name: "Existing Community",
      human_verification_lane: "very",
      agent_posting_policy: "allow",
      agent_posting_scope: "top_level_and_replies",
      accepted_agent_ownership_providers: ["clawkey"],
    })

    rmSync(tmpDir, { recursive: true, force: true })
  })

  test("namespace attach execution rejects placeholder ids", () => {
    expect(() => assertExecutableNamespaceVerificationId("nv_REPLACE_WITH_PROD_ID")).toThrow("placeholder")
    assertExecutableNamespaceVerificationId("nv_1234567890abcdef1234567890abcdef")
  })

  test("buildManifestPlan rejects partial create metadata", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pirate-cli-manifest-"))
    const manifestPath = join(tmpDir, "community.yaml")
    writeFileSync(manifestPath, [
      "namespace_verification_id: nv_missing_display",
    ].join("\n"))

    expect(() => buildManifestPlan(tmpDir, manifestPath, null)).toThrow("display_name and namespace_verification_id")

    rmSync(tmpDir, { recursive: true, force: true })
  })

  test("buildConventionalFolderPlan reads standard txt/json community folder files", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "@pirate-cli-convention-"))
    writeFileSync(join(tmpDir, "name.txt"), "Convention Community\n")
    writeFileSync(join(tmpDir, "description.txt"), "Convention description")
    writeFileSync(join(tmpDir, "rules.txt"), "Rule One\n\nRule body")
    writeFileSync(join(tmpDir, "links.json"), JSON.stringify([{ platform: "web", url: "https://example.com" }]))

    const plan = buildConventionalFolderPlan(tmpDir, null)
    expect(plan.lookupIdentifier).toBe(basename(tmpDir))
    expect(plan.steps.map((step) => step.kind)).toEqual(["update", "rules", "links"])
    expect(plan.steps[0]?.kind === "update" ? plan.steps[0].body : null).toEqual({
      display_name: "Convention Community",
      description: "Convention description",
    })

    rmSync(tmpDir, { recursive: true, force: true })
  })

  test("buildConventionalFolderPlan rejects unknown sidecar files", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "@pirate-cli-convention-"))
    writeFileSync(join(tmpDir, "labesl.json"), "{}")

    expect(() => buildConventionalFolderPlan(tmpDir, null)).toThrow("Unknown community folder file")

    rmSync(tmpDir, { recursive: true, force: true })
  })

  test("buildManifestPlan rejects duplicate seed post idempotency keys", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pirate-cli-manifest-"))
    const manifestPath = join(tmpDir, "community.yaml")
    writeFileSync(manifestPath, [
      "community_id: cmt_test123",
      "seed_accounts_file: seed-accounts.json",
      "seed_posts_file: seed-posts.json",
    ].join("\n"))
    writeFileSync(join(tmpDir, "seed-accounts.json"), JSON.stringify({ editorial: "usr_editorial" }))
    writeFileSync(join(tmpDir, "seed-posts.json"), JSON.stringify([
      { as: "editorial", idempotency_key: "dupe", body: "One" },
      { as: "editorial", idempotency_key: "dupe", body: "Two" },
    ]))

    expect(() => buildManifestPlan(tmpDir, manifestPath, null)).toThrow("Duplicate seed post idempotency_key")

    rmSync(tmpDir, { recursive: true, force: true })
  })

  test("buildManifestPlan rejects unresolved post aliases", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pirate-cli-manifest-"))
    const manifestPath = join(tmpDir, "community.yaml")
    writeFileSync(manifestPath, [
      "community_id: cmt_test123",
      "seed_accounts_file: seed-accounts.json",
      "seed_comments_file: seed-comments.json",
    ].join("\n"))
    writeFileSync(join(tmpDir, "seed-accounts.json"), JSON.stringify({ curator: "usr_curator" }))
    writeFileSync(join(tmpDir, "seed-comments.json"), JSON.stringify([
      { as: "curator", post_alias: "missing", idempotency_key: "comment-1", body: "Reply" },
    ]))

    expect(() => buildManifestPlan(tmpDir, manifestPath, null)).toThrow("unknown post_alias")

    rmSync(tmpDir, { recursive: true, force: true })
  })

  test("buildManifestPlan builds seed operation steps from sidecar files", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pirate-cli-manifest-"))
    const manifestPath = join(tmpDir, "community.yaml")
    writeFileSync(manifestPath, [
      "community_id: cmt_test123",
      "seed_accounts_file: seed-accounts.json",
      "profile_updates_file: profile-updates.json",
      "joins_file: joins.json",
      "follows_file: follows.json",
      "seed_posts_file: seed-posts.json",
      "seed_comments_file: seed-comments.json",
      "post_votes_file: post-votes.json",
      "comment_votes_file: comment-votes.json",
    ].join("\n"))
    writeFileSync(join(tmpDir, "seed-accounts.json"), JSON.stringify({
      editorial: "usr_editorial",
      curator: "usr_curator",
    }))
    writeFileSync(join(tmpDir, "bio.md"), "Community editor")
    writeFileSync(join(tmpDir, "post.md"), "Welcome body")
    writeFileSync(join(tmpDir, "comment.md"), "Welcome comment")
    writeFileSync(join(tmpDir, "profile-updates.json"), JSON.stringify([
      { as: "editorial", display_name: "Editor", bio_file: "bio.md" },
    ]))
    writeFileSync(join(tmpDir, "joins.json"), JSON.stringify([{ as: "editorial" }]))
    writeFileSync(join(tmpDir, "follows.json"), JSON.stringify([{ as: "curator" }]))
    writeFileSync(join(tmpDir, "seed-posts.json"), JSON.stringify([
      { as: "editorial", alias: "welcome", idempotency_key: "welcome-001", title: "Welcome", body_file: "post.md" },
    ]))
    writeFileSync(join(tmpDir, "seed-comments.json"), JSON.stringify([
      { as: "curator", alias: "welcome-reply", idempotency_key: "welcome-reply-001", post_alias: "welcome", body_file: "comment.md" },
    ]))
    writeFileSync(join(tmpDir, "post-votes.json"), JSON.stringify([
      { as: "curator", post_alias: "welcome", value: 1 },
    ]))
    writeFileSync(join(tmpDir, "comment-votes.json"), JSON.stringify([
      { as_user_id: "usr_editorial", comment_alias: "welcome-reply", value: "-1" },
    ]))

    expect(() => buildManifestPlan(tmpDir, manifestPath, null)).toThrow("Vote seed files require --allow-vote-seed")

    const plan = buildManifestPlan(tmpDir, manifestPath, null, { allowVoteSeed: true })
    expect(plan.steps.map((step) => step.kind)).toEqual([
      "profile-update",
      "join",
      "follow",
      "seed-post",
      "seed-comment",
      "post-vote",
      "comment-vote",
    ])
    expect(plan.steps[0]?.kind).toBe("profile-update")
    expect("asUserId" in plan.steps[0] ? plan.steps[0].asUserId : null).toBe("usr_editorial")
    expect(plan.steps[3]?.kind).toBe("seed-post")
    expect("asUserId" in plan.steps[3] ? plan.steps[3].asUserId : null).toBe("usr_editorial")
    expect("alias" in plan.steps[3] ? plan.steps[3].alias : null).toBe("welcome")
    expect(plan.steps[4]?.kind).toBe("seed-comment")
    expect("asUserId" in plan.steps[4] ? plan.steps[4].asUserId : null).toBe("usr_curator")
    expect("postAlias" in plan.steps[4] ? plan.steps[4].postAlias : null).toBe("welcome")
    expect("alias" in plan.steps[4] ? plan.steps[4].alias : null).toBe("welcome-reply")
    expect("commentAlias" in plan.steps[6] ? plan.steps[6].commentAlias : null).toBe("welcome-reply")

    rmSync(tmpDir, { recursive: true, force: true })
  })

  test("buildJsonManifestPlan builds seed operation steps from inline fields", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pirate-cli-json-manifest-"))
    const manifestPath = join(tmpDir, "incremental.json")
    writeFileSync(join(tmpDir, "comment.md"), "Inline comment")
    writeFileSync(manifestPath, JSON.stringify({
      community_id: "cmt_test123",
      seed_accounts: {
        editorial: "usr_editorial",
        curator: { user_id: "usr_curator", provider: "bot_wallet" },
      },
      joins: [{ as: "editorial" }],
      follows: [{ as: "curator" }],
      seed_comments: [
        {
          as: "curator",
          alias: "reply",
          post_id: "pst_123",
          idempotency_key: "reply-001",
          body_file: "comment.md",
        },
      ],
    }))

    const plan = buildJsonManifestPlan(manifestPath, null)
    expect(plan.communityId).toBe("cmt_test123")
    expect(plan.steps.map((step) => step.kind)).toEqual(["join", "follow", "seed-comment"])
    expect("asUserId" in plan.steps[0] ? plan.steps[0].asUserId : null).toBe("usr_editorial")
    expect("asUserId" in plan.steps[2] ? plan.steps[2].asUserId : null).toBe("usr_curator")
    expect(plan.steps[2]?.kind === "seed-comment" ? plan.steps[2].body : null).toEqual({
      idempotency_key: "reply-001",
      body: "Inline comment",
      identity_mode: "public",
    })

    rmSync(tmpDir, { recursive: true, force: true })
  })

  test("buildJsonManifestPlan rejects inline and file fields together", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pirate-cli-json-manifest-"))
    const manifestPath = join(tmpDir, "bad.json")
    writeFileSync(manifestPath, JSON.stringify({
      community_id: "cmt_test123",
      joins: [],
      joins_file: "joins.json",
    }))

    expect(() => buildJsonManifestPlan(manifestPath, null)).toThrow("cannot specify both joins and joins_file")

    rmSync(tmpDir, { recursive: true, force: true })
  })

  test("buildJsonManifestPlan guards inline vote fields", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pirate-cli-json-manifest-"))
    const manifestPath = join(tmpDir, "votes.json")
    writeFileSync(manifestPath, JSON.stringify({
      community_id: "cmt_test123",
      seed_accounts: { curator: "usr_curator" },
      post_votes: [{ as: "curator", post_id: "pst_123", value: 1 }],
    }))

    expect(() => buildJsonManifestPlan(manifestPath, null)).toThrow("Vote seed files require --allow-vote-seed")
    expect(buildJsonManifestPlan(manifestPath, null, { allowVoteSeed: true }).steps.map((step) => step.kind)).toEqual(["post-vote"])

    rmSync(tmpDir, { recursive: true, force: true })
  })

  test("buildManifestPlan builds link and image seed post payloads", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pirate-cli-manifest-"))
    const manifestPath = join(tmpDir, "community.yaml")
    writeFileSync(manifestPath, [
      "community_id: cmt_test123",
      "seed_accounts_file: seed-accounts.json",
      "seed_posts_file: seed-posts.json",
    ].join("\n"))
    writeFileSync(join(tmpDir, "seed-accounts.json"), JSON.stringify({ editorial: "usr_editorial" }))
    writeFileSync(join(tmpDir, "image-media.json"), JSON.stringify([{
      storage_ref: "community-media/post_image/example.png",
      mime_type: "image/png",
      width: 1200,
      height: 800,
    }]))
    writeFileSync(join(tmpDir, "seed-posts.json"), JSON.stringify([
      {
        as: "editorial",
        alias: "launch-link",
        idempotency_key: "launch-link-001",
        post_type: "link",
        title: "Launch link",
        body: "Launch context",
        link_url: "https://example.com/launch",
      },
      {
        as: "editorial",
        alias: "launch-image",
        idempotency_key: "launch-image-001",
        post_type: "image",
        title: "Launch image",
        caption: "First image",
        media_refs_file: "image-media.json",
      },
    ]))

    const plan = buildManifestPlan(tmpDir, manifestPath, null)
    expect(plan.steps.map((step) => step.kind)).toEqual(["seed-post", "seed-post"])
    expect(plan.steps[0]?.kind === "seed-post" ? plan.steps[0].body : null).toEqual({
      post_type: "link",
      identity_mode: "public",
      visibility: "public",
      idempotency_key: "launch-link-001",
      title: "Launch link",
      body: "Launch context",
      link_url: "https://example.com/launch",
    })
    expect(plan.steps[1]?.kind === "seed-post" ? plan.steps[1].body : null).toEqual({
      post_type: "image",
      identity_mode: "public",
      visibility: "public",
      idempotency_key: "launch-image-001",
      title: "Launch image",
      caption: "First image",
      media_refs: [{
        storage_ref: "community-media/post_image/example.png",
        mime_type: "image/png",
        width: 1200,
        height: 800,
      }],
    })

    rmSync(tmpDir, { recursive: true, force: true })
  })

  test("buildManifestPlan rejects seed posts without idempotency keys", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pirate-cli-manifest-"))
    const manifestPath = join(tmpDir, "community.yaml")
    writeFileSync(manifestPath, [
      "community_id: cmt_test123",
      "seed_accounts_file: seed-accounts.json",
      "seed_posts_file: seed-posts.json",
    ].join("\n"))
    writeFileSync(join(tmpDir, "seed-accounts.json"), JSON.stringify({ editorial: "usr_editorial" }))
    writeFileSync(join(tmpDir, "seed-posts.json"), JSON.stringify([{ as: "editorial", body: "Missing idempotency key" }]))

    expect(() => buildManifestPlan(tmpDir, manifestPath, null)).toThrow("idempotency_key")

    rmSync(tmpDir, { recursive: true, force: true })
  })

  test("buildManifestPlan rejects seed comments without idempotency keys", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pirate-cli-manifest-"))
    const manifestPath = join(tmpDir, "community.yaml")
    writeFileSync(manifestPath, [
      "community_id: cmt_test123",
      "seed_accounts_file: seed-accounts.json",
      "seed_comments_file: seed-comments.json",
    ].join("\n"))
    writeFileSync(join(tmpDir, "seed-accounts.json"), JSON.stringify({ curator: "usr_curator" }))
    writeFileSync(join(tmpDir, "seed-comments.json"), JSON.stringify([{ as: "curator", post_id: "pst_123", body: "Missing idempotency key" }]))

    expect(() => buildManifestPlan(tmpDir, manifestPath, null)).toThrow("idempotency_key")

    rmSync(tmpDir, { recursive: true, force: true })
  })

  test("buildManifestPlan parses agent posting fields from manifest", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "@pirate-cli-manifest-"))
    const manifestPath = join(tmpDir, "community.yaml")
    writeFileSync(manifestPath, [
      "route_slug: @agent-community",
      "display_name: Agent Community",
      "namespace_verification_id: nv_test456",
      "description_file: description.txt",
      "human_verification_lane: very",
      "agent_posting_policy: allow",
      "agent_posting_scope: top_level_and_replies",
      "agent_daily_post_cap: 10",
      "agent_daily_reply_cap: 50",
      "accepted_agent_ownership_providers: clawkey",
    ].join("\n"))
    writeFileSync(join(tmpDir, "description.txt"), "Community with agents")

    const plan = buildManifestPlan(tmpDir, manifestPath, null)
    expect(plan.create).toEqual({
      displayName: "Agent Community",
      description: "Community with agents",
      namespaceVerificationId: "nv_test456",
      membershipMode: "open",
      governanceMode: "centralized",
      defaultAgeGatePolicy: "none",
      allowAnonymousIdentity: false,
      humanVerificationLane: "very",
      agentPostingPolicy: "allow",
      agentPostingScope: "top_level_and_replies",
      agentDailyPostCap: 10,
      agentDailyReplyCap: 50,
      acceptedAgentOwnershipProviders: ["clawkey"],
    })

    rmSync(tmpDir, { recursive: true, force: true })
  })

  test("buildManifestPlan parses accepted_agent_ownership_providers as comma-separated", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "@pirate-cli-manifest-"))
    const manifestPath = join(tmpDir, "community.yaml")
    writeFileSync(manifestPath, [
      "display_name: Multi Provider",
      "namespace_verification_id: nv_test789",
      "accepted_agent_ownership_providers: clawkey,self_agent_id",
    ].join("\n"))

    const plan = buildManifestPlan(tmpDir, manifestPath, null)
    expect(plan.create?.acceptedAgentOwnershipProviders).toEqual(["clawkey", "self_agent_id"])

    rmSync(tmpDir, { recursive: true, force: true })
  })

  test("buildManifestPlan rejects invalid agent_posting_policy", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "@pirate-cli-manifest-"))
    const manifestPath = join(tmpDir, "community.yaml")
    writeFileSync(manifestPath, [
      "display_name: Bad Policy",
      "namespace_verification_id: nv_test_bad",
      "agent_posting_policy: anything_goes",
    ].join("\n"))

    expect(() => buildManifestPlan(tmpDir, manifestPath, null)).toThrow("agent_posting_policy must be one of")

    rmSync(tmpDir, { recursive: true, force: true })
  })

  test("buildManifestPlan rejects invalid accepted_agent_ownership_providers", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "@pirate-cli-manifest-"))
    const manifestPath = join(tmpDir, "community.yaml")
    writeFileSync(manifestPath, [
      "display_name: Bad Provider",
      "namespace_verification_id: nv_test_bad2",
      "accepted_agent_ownership_providers: unknown_provider",
    ].join("\n"))

    expect(() => buildManifestPlan(tmpDir, manifestPath, null)).toThrow("invalid value")

    rmSync(tmpDir, { recursive: true, force: true })
  })

  test("buildManifestPlan rejects non-positive agent_daily_post_cap", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "@pirate-cli-manifest-"))
    const manifestPath = join(tmpDir, "community.yaml")
    writeFileSync(manifestPath, [
      "display_name: Bad Cap",
      "namespace_verification_id: nv_test_bad3",
      "agent_daily_post_cap: 0",
    ].join("\n"))

    expect(() => buildManifestPlan(tmpDir, manifestPath, null)).toThrow("positive integer")

    rmSync(tmpDir, { recursive: true, force: true })
  })
})

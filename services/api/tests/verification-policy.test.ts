import { describe, expect, test } from "bun:test"
import {
  boolToDb,
  deriveHnsInspectionSnapshot,
  deriveAcceptedHnsSnapshot,
  deriveSpacesAcceptedSnapshot,
  getHnsChallengeTtlHours,
  isTrustedHnsAuthorityObservation,
  parseStoredSpacesChallenge,
} from "../src/lib/verification/namespace-verification-policy"
import type { HnsInspectResult, HnsVerifyTxtResult } from "../src/lib/verification/hns-verifier"
import type { SpacesChallengePayload } from "../src/lib/verification/spaces-verifier"
import type { NamespaceVerificationSessionRow } from "../src/lib/auth/auth-db-rows"
import { LOCAL_DEV_HNS_OBSERVATION_PROVIDER } from "../src/lib/verification/namespace-observation-provider"

function stubRow(overrides: Partial<NamespaceVerificationSessionRow> = {}): NamespaceVerificationSessionRow {
  return {
    namespace_verification_session_id: "nvs_test",
    namespace_verification_id: null,
    user_id: "user_test",
    family: "hns",
    submitted_root_label: "TestRoot",
    normalized_root_label: "testroot",
    status: "challenge_required",
    challenge_kind: "dns_txt",
    challenge_payload_json: null,
    challenge_host: "_pirate.testroot",
    challenge_txt_value: "pirate-verification=nvs_test",
    setup_nameservers_json: null,
    challenge_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    root_exists: null,
    root_control_verified: null,
    expiry_horizon_sufficient: null,
    routing_enabled: null,
    pirate_dns_authority_verified: null,
    authority_health_verified: null,
    ownership_source: null,
    root_key_proof_verified: null,
    fabric_publish_verified: null,
    anchor_fresh_enough: null,
    owner_signed_updates_verified: null,
    club_attach_allowed: null,
    pirate_web_routing_allowed: null,
    pirate_subdomain_issuance_allowed: null,
    owner_signed_record_updates_allowed: null,
    pirate_subspace_issuance_allowed: null,
    control_class: null,
    operation_class: null,
    observation_provider: LOCAL_DEV_HNS_OBSERVATION_PROVIDER,
    evidence_bundle_ref: null,
    failure_reason: null,
    accepted_at: null,
    anchor_height: null,
    anchor_block_hash: null,
    anchor_root_hash: null,
    proof_root_hash: null,
    expires_at: new Date(Date.now() + 86400_000).toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  }
}

function stubChallengePayload(overrides: Partial<SpacesChallengePayload> = {}): SpacesChallengePayload {
  return {
    kind: "fabric_txt_publish",
    domain: "pirate.sc",
    root_label: "testroot",
    root_pubkey: "test-pubkey",
    nonce: "nvs_test:abc123",
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    txt_key: "pirate-verify",
    txt_value: "pirate-space-verify=nvs_test:abc123",
    web_url: "https://pirate.sc/c/@testroot",
    freedom_url: "https://pirate.sc/c/@testroot",
    ...overrides,
  }
}

describe("boolToDb", () => {
  test("converts true to 1", () => {
    expect(boolToDb(true)).toBe(1)
  })

  test("converts false to 0", () => {
    expect(boolToDb(false)).toBe(0)
  })

  test("converts null to null", () => {
    expect(boolToDb(null)).toBeNull()
  })

  test("converts undefined to null", () => {
    expect(boolToDb(undefined)).toBeNull()
  })
})

describe("getHnsChallengeTtlHours", () => {
  test("defaults to seven days", () => {
    expect(getHnsChallengeTtlHours({} as any)).toBe(168)
  })

  test("supports a bounded override", () => {
    expect(getHnsChallengeTtlHours({ HNS_CHALLENGE_TTL_HOURS: "72" } as any)).toBe(72)
    expect(getHnsChallengeTtlHours({ HNS_CHALLENGE_TTL_HOURS: "999" } as any)).toBe(168)
  })
})

describe("deriveHnsInspectionSnapshot", () => {
  test("maps a fully populated inspection", () => {
    const inspection: HnsInspectResult = {
      root_exists: true,
      root_control_verified: true,
      expiry_horizon_sufficient: true,
      routing_enabled: true,
      pirate_dns_authority_verified: true,
      control_class: "single_holder_root",
      operation_class: "owner_managed_namespace",
      observation_provider: "web3dns_json_doh",
    }
    const snapshot = deriveHnsInspectionSnapshot(inspection)
    expect(snapshot.rootExists).toBe(1)
    expect(snapshot.rootControlVerified).toBe(1)
    expect(snapshot.expiryHorizonSufficient).toBe(1)
    expect(snapshot.routingEnabled).toBe(1)
    expect(snapshot.pirateDnsAuthorityVerified).toBe(1)
    expect(snapshot.controlClass).toBe("single_holder_root")
    expect(snapshot.operationClass).toBe("owner_managed_namespace")
    expect(snapshot.clubAttachAllowed).toBeNull()
    expect(snapshot.pirateWebRoutingAllowed).toBeNull()
    expect(snapshot.pirateSubdomainIssuanceAllowed).toBeNull()
  })

  test("falls back to zone_exists when root_exists is missing", () => {
    const inspection: HnsInspectResult = {
      zone_exists: true,
      observation_provider: "web3dns_json_doh",
    }
    const snapshot = deriveHnsInspectionSnapshot(inspection)
    expect(snapshot.rootExists).toBe(1)
  })

  test("maps all false assertions", () => {
    const inspection: HnsInspectResult = {
      root_exists: false,
      root_control_verified: false,
      expiry_horizon_sufficient: false,
      routing_enabled: false,
      pirate_dns_authority_verified: false,
      control_class: "dao_controlled_root",
      operation_class: "routing_only_namespace",
      observation_provider: "web3dns_json_doh",
    }
    const snapshot = deriveHnsInspectionSnapshot(inspection)
    expect(snapshot.rootExists).toBe(0)
    expect(snapshot.rootControlVerified).toBe(0)
    expect(snapshot.expiryHorizonSufficient).toBe(0)
    expect(snapshot.routingEnabled).toBe(0)
    expect(snapshot.pirateDnsAuthorityVerified).toBe(0)
    expect(snapshot.controlClass).toBe("dao_controlled_root")
    expect(snapshot.operationClass).toBe("routing_only_namespace")
  })

  test("maps null assertions to null", () => {
    const inspection: HnsInspectResult = {
      observation_provider: "web3dns_json_doh",
    }
    const snapshot = deriveHnsInspectionSnapshot(inspection)
    expect(snapshot.rootExists).toBeNull()
    expect(snapshot.rootControlVerified).toBeNull()
    expect(snapshot.expiryHorizonSufficient).toBeNull()
    expect(snapshot.routingEnabled).toBeNull()
    expect(snapshot.pirateDnsAuthorityVerified).toBeNull()
    expect(snapshot.controlClass).toBeNull()
    expect(snapshot.operationClass).toBeNull()
  })
})

describe("isTrustedHnsAuthorityObservation", () => {
  test("production rejects non-allowlisted TXT verification providers", () => {
    expect(isTrustedHnsAuthorityObservation({
      ENVIRONMENT: "production",
    } as never, {
      observation_provider: "local_untrusted_resolver",
    })).toBe(false)
  })

  test("production rejects unknown TXT verification providers by default", () => {
    expect(isTrustedHnsAuthorityObservation({
      ENVIRONMENT: "production",
    } as never, {
      observation_provider: "future_weak_provider",
    })).toBe(false)
  })

  test("production rejects PowerDNS observations as standalone HNS ownership proof", () => {
    expect(isTrustedHnsAuthorityObservation({
      ENVIRONMENT: "production",
    } as never, {
      observation_provider: "powerdns_sqlite",
    })).toBe(false)
  })

  test("production accepts HNS public DNS, Web3DNS, and parent-chain observations", () => {
    expect(isTrustedHnsAuthorityObservation({
      ENVIRONMENT: "production",
    } as never, {
      observation_provider: "web3dns_json_doh",
    })).toBe(true)
    expect(isTrustedHnsAuthorityObservation({
      ENVIRONMENT: "production",
    } as never, {
      observation_provider: "hns_public_dns",
    })).toBe(true)
    expect(isTrustedHnsAuthorityObservation({
      ENVIRONMENT: "production",
    } as never, {
      observation_provider: "web3dns_public_dns",
    })).toBe(true)
    expect(isTrustedHnsAuthorityObservation({
      ENVIRONMENT: "production",
    } as never, {
      observation_provider: "hns_parent_chain",
    })).toBe(true)
  })

  test("local environments can use verifier doubles", () => {
    expect(isTrustedHnsAuthorityObservation({
      ENVIRONMENT: "development",
    } as never, {
      observation_provider: "local_test_verifier",
    })).toBe(true)
  })
})

describe("deriveAcceptedHnsSnapshot", () => {
  test("derives capabilities from a verified TXT result", () => {
    const row = stubRow({
      root_exists: null,
      root_control_verified: null,
      expiry_horizon_sufficient: null,
      routing_enabled: null,
      pirate_dns_authority_verified: null,
      control_class: null,
      operation_class: null,
      observation_provider: "web3dns_json_doh",
    })
    const verification: HnsVerifyTxtResult = {
      verified: true,
      root_exists: true,
      root_control_verified: true,
      expiry_horizon_sufficient: true,
      routing_enabled: true,
      pirate_dns_authority_verified: true,
      control_class: "single_holder_root",
      operation_class: "owner_managed_namespace",
      observation_provider: "web3dns_json_doh",
    }
    // Pirate-managed authority, so routing/subdomain capabilities require the
    // authority-health assertion (see hns-assertion-policy.test.ts).
    const snapshot = deriveAcceptedHnsSnapshot(row, verification, 1)
    expect(snapshot.rootExists).toBe(1)
    expect(snapshot.rootControlVerified).toBe(1)
    expect(snapshot.expiryHorizonSufficient).toBe(1)
    expect(snapshot.routingEnabled).toBe(1)
    expect(snapshot.pirateDnsAuthorityVerified).toBe(1)
    expect(snapshot.clubAttachAllowed).toBe(1)
    expect(snapshot.pirateWebRoutingAllowed).toBe(1)
    expect(snapshot.pirateSubdomainIssuanceAllowed).toBe(1)
    expect(snapshot.controlClass).toBe("single_holder_root")
    expect(snapshot.operationClass).toBe("owner_managed_namespace")

    // Without health evidence the same verification must not grant routing.
    const unhealthy = deriveAcceptedHnsSnapshot(row, verification, null)
    expect(unhealthy.pirateWebRoutingAllowed).toBe(0)
    expect(unhealthy.pirateSubdomainIssuanceAllowed).toBe(0)
  })

  test("falls back to row values when verification omits fields", () => {
    const row = stubRow({
      root_exists: 1,
      root_control_verified: 1,
      expiry_horizon_sufficient: 1,
      routing_enabled: 0,
      pirate_dns_authority_verified: 0,
      control_class: "single_holder_root",
      operation_class: "owner_managed_namespace",
    })
    const verification: HnsVerifyTxtResult = {
      verified: true,
      observation_provider: "web3dns_json_doh",
    }
    const snapshot = deriveAcceptedHnsSnapshot(row, verification)
    expect(snapshot.rootExists).toBe(1)
    expect(snapshot.rootControlVerified).toBe(1)
    expect(snapshot.expiryHorizonSufficient).toBe(1)
    expect(snapshot.routingEnabled).toBe(0)
    expect(snapshot.pirateDnsAuthorityVerified).toBe(0)
    expect(snapshot.clubAttachAllowed).toBe(1)
    expect(snapshot.pirateWebRoutingAllowed).toBe(0)
    expect(snapshot.pirateSubdomainIssuanceAllowed).toBe(0)
  })

  test("infers root_exists from hasAcceptedTxtProof when both row and verification are null", () => {
    const row = stubRow({
      root_exists: null,
      root_control_verified: null,
      observation_provider: "web3dns_json_doh",
    })
    const verification: HnsVerifyTxtResult = {
      verified: true,
      observation_provider: "web3dns_json_doh",
    }
    const snapshot = deriveAcceptedHnsSnapshot(row, verification)
    expect(snapshot.rootExists).toBe(1)
    expect(snapshot.rootControlVerified).toBe(1)
  })

  test("local dev acceptance fills defaults for root_exists and root_control_verified", () => {
    const row = stubRow({
      root_exists: null,
      root_control_verified: null,
      expiry_horizon_sufficient: null,
      routing_enabled: null,
      pirate_dns_authority_verified: null,
      observation_provider: LOCAL_DEV_HNS_OBSERVATION_PROVIDER,
    })
    const snapshot = deriveAcceptedHnsSnapshot(row, null)
    expect(snapshot.rootExists).toBe(1)
    expect(snapshot.rootControlVerified).toBe(1)
    expect(snapshot.expiryHorizonSufficient).toBe(1)
    expect(snapshot.routingEnabled).toBe(1)
    expect(snapshot.pirateDnsAuthorityVerified).toBe(1)
  })

  test("non-stub null verification leaves root_exists null", () => {
    const row = stubRow({
      root_exists: null,
      root_control_verified: null,
      observation_provider: "web3dns_json_doh",
    })
    const snapshot = deriveAcceptedHnsSnapshot(row, null)
    expect(snapshot.rootExists).toBeNull()
    expect(snapshot.rootControlVerified).toBeNull()
  })

  test("leaves control metadata null when neither row nor verifier can prove it", () => {
    const row = stubRow({
      control_class: null,
      operation_class: null,
      observation_provider: "web3dns_json_doh",
    })
    const verification: HnsVerifyTxtResult = {
      verified: true,
      observation_provider: "web3dns_json_doh",
    }
    const snapshot = deriveAcceptedHnsSnapshot(row, verification)
    expect(snapshot.controlClass).toBeNull()
    expect(snapshot.operationClass).toBeNull()
  })

  test("expiry_horizon_sufficient=false denies club_attach", () => {
    const row = stubRow({
      root_control_verified: 1,
      expiry_horizon_sufficient: 0,
      routing_enabled: 1,
      pirate_dns_authority_verified: 1,
    })
    const snapshot = deriveAcceptedHnsSnapshot(row, null, 1)
    expect(snapshot.clubAttachAllowed).toBe(0)
    expect(snapshot.pirateWebRoutingAllowed).toBe(1)
    expect(snapshot.pirateSubdomainIssuanceAllowed).toBe(0)
  })

  test("dao_controlled_root with routing_only_namespace derives correct capabilities", () => {
    const row = stubRow({
      root_exists: 1,
      root_control_verified: 1,
      expiry_horizon_sufficient: 0,
      routing_enabled: 1,
      pirate_dns_authority_verified: 1,
      control_class: "dao_controlled_root",
      operation_class: "routing_only_namespace",
    })
    const snapshot = deriveAcceptedHnsSnapshot(row, null, 1)
    expect(snapshot.clubAttachAllowed).toBe(0)
    expect(snapshot.pirateWebRoutingAllowed).toBe(1)
    expect(snapshot.pirateSubdomainIssuanceAllowed).toBe(0)
    expect(snapshot.controlClass).toBe("dao_controlled_root")
    expect(snapshot.operationClass).toBe("routing_only_namespace")
  })
})

describe("deriveSpacesAcceptedSnapshot", () => {
  test("derives snapshot from a fully verified spaces row", () => {
    const row = stubRow({
      family: "spaces",
      root_control_verified: 1,
      expiry_horizon_sufficient: 1,
      routing_enabled: 1,
      control_class: "single_holder_root",
      operation_class: "owner_managed_namespace",
    })
    const snapshot = deriveSpacesAcceptedSnapshot(row)
    expect(snapshot.rootExists).toBe(1)
    expect(snapshot.rootControlVerified).toBe(1)
    expect(snapshot.fabricPublishVerified).toBe(1)
    expect(snapshot.expiryHorizonSufficient).toBe(1)
    expect(snapshot.routingEnabled).toBe(1)
    expect(snapshot.pirateDnsAuthorityVerified).toBe(0)
    expect(snapshot.clubAttachAllowed).toBe(1)
    expect(snapshot.pirateWebRoutingAllowed).toBe(1)
    expect(snapshot.pirateSubdomainIssuanceAllowed).toBe(0)
    expect(snapshot.ownerSignedRecordUpdatesAllowed).toBe(0)
    expect(snapshot.pirateSubspaceIssuanceAllowed).toBe(0)
  })

  test("root_control_verified=0 denies all attach/routing capabilities", () => {
    const row = stubRow({
      family: "spaces",
      root_control_verified: 0,
      expiry_horizon_sufficient: 1,
      routing_enabled: 1,
    })
    const snapshot = deriveSpacesAcceptedSnapshot(row)
    expect(snapshot.clubAttachAllowed).toBe(0)
    expect(snapshot.pirateWebRoutingAllowed).toBe(0)
    expect(snapshot.ownerSignedRecordUpdatesAllowed).toBe(0)
  })

  test("owner_signed_updates_namespace with root control grants owner_signed_record_updates_allowed", () => {
    const row = stubRow({
      family: "spaces",
      root_control_verified: 1,
      operation_class: "owner_signed_updates_namespace",
    })
    const snapshot = deriveSpacesAcceptedSnapshot(row)
    expect(snapshot.ownerSignedRecordUpdatesAllowed).toBe(1)
  })

  test("owner_signed_updates_namespace without root control denies owner_signed_record_updates_allowed", () => {
    const row = stubRow({
      family: "spaces",
      root_control_verified: 0,
      operation_class: "owner_signed_updates_namespace",
    })
    const snapshot = deriveSpacesAcceptedSnapshot(row)
    expect(snapshot.ownerSignedRecordUpdatesAllowed).toBe(0)
  })

  test("expiry_horizon_sufficient=null denies club_attach", () => {
    const row = stubRow({
      family: "spaces",
      root_control_verified: 1,
      expiry_horizon_sufficient: null,
    })
    const snapshot = deriveSpacesAcceptedSnapshot(row)
    expect(snapshot.clubAttachAllowed).toBe(0)
  })

  test("pirate_subspace_issuance is always 0 for spaces", () => {
    const row = stubRow({
      family: "spaces",
      root_control_verified: 1,
      expiry_horizon_sufficient: 1,
      pirate_dns_authority_verified: 1,
    })
    const snapshot = deriveSpacesAcceptedSnapshot(row)
    expect(snapshot.pirateSubspaceIssuanceAllowed).toBe(0)
  })
})

describe("parseStoredSpacesChallenge", () => {
  test("parses a valid challenge payload", () => {
    const payload = stubChallengePayload()
    const result = parseStoredSpacesChallenge(JSON.stringify(payload))
    expect(result.kind).toBe("fabric_txt_publish")
    expect(result.txt_key).toBe("pirate-verify")
    expect(result.txt_value).toBe(payload.txt_value)
    expect(result.web_url).toBe(payload.web_url)
    expect(result.root_pubkey).toBe(payload.root_pubkey)
    expect(result.nonce).toBe(payload.nonce)
    expect(result.root_label).toBe(payload.root_label)
    expect(result.domain).toBe(payload.domain)
  })

  test("throws on null input", () => {
    expect(() => parseStoredSpacesChallenge(null)).toThrow()
  })

  test("throws on malformed JSON", () => {
    expect(() => parseStoredSpacesChallenge("{not json")).toThrow()
  })

  test("throws when kind is wrong", () => {
    const payload = stubChallengePayload({ kind: "wrong_kind" as SpacesChallengePayload["kind"] })
    expect(() => parseStoredSpacesChallenge(JSON.stringify(payload))).toThrow()
  })

  test("throws when txt_value is missing", () => {
    const payload = stubChallengePayload()
    const withoutTxtValue = { ...payload, txt_value: undefined }
    expect(() => parseStoredSpacesChallenge(JSON.stringify(withoutTxtValue))).toThrow()
  })

  test("throws when root_pubkey is missing", () => {
    const payload = stubChallengePayload()
    const withoutPubkey = { ...payload, root_pubkey: undefined }
    expect(() => parseStoredSpacesChallenge(JSON.stringify(withoutPubkey))).toThrow()
  })

  test("throws when nonce is missing", () => {
    const payload = stubChallengePayload()
    const withoutNonce = { ...payload, nonce: undefined }
    expect(() => parseStoredSpacesChallenge(JSON.stringify(withoutNonce))).toThrow()
  })

  test("throws when root_label is missing", () => {
    const payload = stubChallengePayload()
    const withoutRootLabel = { ...payload, root_label: undefined }
    expect(() => parseStoredSpacesChallenge(JSON.stringify(withoutRootLabel))).toThrow()
  })

  test("throws when web_url is missing", () => {
    const payload = stubChallengePayload()
    const withoutWebUrl = { ...payload, web_url: undefined }
    expect(() => parseStoredSpacesChallenge(JSON.stringify(withoutWebUrl))).toThrow()
  })
})

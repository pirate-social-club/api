import { describe, expect, test } from "bun:test"
import type { NamespaceVerificationSessionRow } from "../auth/auth-db-rows"
import type { HnsVerifyTxtResult } from "./hns-verifier"
import { deriveAcceptedHnsSnapshot, isTrustedHnsAuthorityObservation } from "./namespace-verification-policy"

const PROD_ENV = { ENVIRONMENT: "production" } as never

function row(): NamespaceVerificationSessionRow {
  return {
    root_exists: null,
    root_control_verified: null,
    expiry_horizon_sufficient: null,
    routing_enabled: null,
    pirate_dns_authority_verified: null,
    control_class: null,
    operation_class: null,
    observation_provider: null,
  } as unknown as NamespaceVerificationSessionRow
}

const PIRATE_MANAGED: HnsVerifyTxtResult = {
  verified: true,
  observation_provider: "hns_parent_chain",
  ownership_source: "hns_parent_chain_txt",
  root_exists: true,
  root_control_verified: true,
  expiry_horizon_sufficient: true,
  routing_enabled: true,
  pirate_dns_authority_verified: true,
  control_class: "single_holder_root",
  operation_class: "pirate_delegated_namespace",
}

const OWNER_MANAGED: HnsVerifyTxtResult = {
  verified: true,
  observation_provider: "owner_authoritative_dns",
  ownership_source: "owner_authoritative_dns_txt",
  root_exists: true,
  root_control_verified: true,
  expiry_horizon_sufficient: true,
  routing_enabled: false,
  pirate_dns_authority_verified: false,
  control_class: "single_holder_root",
  operation_class: "owner_managed_namespace",
}

describe("HNS observation provider trust", () => {
  test("owner-managed authoritative DNS is trusted in production", () => {
    expect(isTrustedHnsAuthorityObservation(PROD_ENV, OWNER_MANAGED)).toBe(true)
  })

  test("parent-chain observation stays trusted in production", () => {
    expect(isTrustedHnsAuthorityObservation(PROD_ENV, PIRATE_MANAGED)).toBe(true)
  })

  test("an unknown observation provider is refused in production", () => {
    expect(isTrustedHnsAuthorityObservation(PROD_ENV, { observation_provider: "attacker_resolver" })).toBe(false)
  })

  test("Pirate's own zones are never a trusted ownership observation", () => {
    // powerdns_api is Pirate reading back what Pirate wrote: health evidence,
    // never ownership.
    expect(isTrustedHnsAuthorityObservation(PROD_ENV, { observation_provider: "powerdns_api" })).toBe(false)
  })
})

describe("routing capabilities are derived after authority health", () => {
  test("a healthy Pirate-managed authority grants routing and subdomain issuance", () => {
    const snapshot = deriveAcceptedHnsSnapshot(row(), PIRATE_MANAGED, 1)
    expect(snapshot.authorityHealthVerified).toBe(1)
    expect(snapshot.pirateWebRoutingAllowed).toBe(1)
    expect(snapshot.pirateSubdomainIssuanceAllowed).toBe(1)
    expect(snapshot.clubAttachAllowed).toBe(1)
  })

  test("an UNHEALTHY Pirate-managed authority withholds routing", () => {
    const snapshot = deriveAcceptedHnsSnapshot(row(), PIRATE_MANAGED, 0)
    expect(snapshot.pirateWebRoutingAllowed).toBe(0)
    expect(snapshot.pirateSubdomainIssuanceAllowed).toBe(0)
    // Ownership still proved, so club attachment is unaffected by DNS health.
    expect(snapshot.clubAttachAllowed).toBe(1)
  })

  test("UNKNOWN health withholds routing (null is not evidence of health)", () => {
    const snapshot = deriveAcceptedHnsSnapshot(row(), PIRATE_MANAGED, null)
    expect(snapshot.pirateWebRoutingAllowed).toBe(0)
    expect(snapshot.pirateSubdomainIssuanceAllowed).toBe(0)
  })

  test("owner-managed roots do not depend on Pirate authority health", () => {
    const snapshot = deriveAcceptedHnsSnapshot(row(), OWNER_MANAGED, null)
    // They route through their own DNS; Pirate's authority is irrelevant, and
    // routing_enabled=false here simply means they have not pointed at us.
    expect(snapshot.pirateWebRoutingAllowed).toBe(0)
    expect(snapshot.clubAttachAllowed).toBe(1)
    expect(snapshot.pirateSubdomainIssuanceAllowed).toBe(0)
  })

  test("owner-managed roots with an unknown expiry horizon cannot attach a club", () => {
    const snapshot = deriveAcceptedHnsSnapshot(
      row(),
      { ...OWNER_MANAGED, expiry_horizon_sufficient: null },
      null,
    )
    expect(snapshot.rootControlVerified).toBe(1)
    expect(snapshot.clubAttachAllowed).toBe(0)
  })
})

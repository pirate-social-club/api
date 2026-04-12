import { createHash } from "node:crypto"
import { badRequestError, conflictError, internalError, notImplementedError, verificationRequired } from "../errors"
import { makeId } from "../helpers"
import { createControlPlaneDbClient, type ControlPlaneDbClient } from "../control-plane-db"
import {
  firstRow,
  getUserRow,
  requireControlPlaneDbUrl,
} from "../auth/control-plane-auth-queries"
import {
  parseVerificationCapabilities,
  serializeNamespaceVerification,
  serializeNamespaceVerificationSession,
  serializeVerificationSession,
} from "../auth/control-plane-auth-serializers"
import type {
  NamespaceVerificationRow,
  NamespaceVerificationSessionRow,
  UserAttestationRow,
  UserRow,
  VerificationSessionRow,
} from "../auth/control-plane-auth-rows"
import {
  toNamespaceVerificationRow,
  toNamespaceVerificationSessionRow,
  toUserAttestationRow,
  toVerificationSessionRow,
} from "../auth/control-plane-auth-rows"
import { verifyHnsTxtChallenge } from "./hns-verifier"
import {
  inspectSpacesNamespace,
  verifySpacesNamespaceSignature,
} from "./spaces-verifier"
import { resolveVerificationSessionPolicy } from "./verification-policies"
import type {
  Env,
  NamespaceVerification,
  NamespaceVerificationSession,
  StartVerificationSessionRequest,
  VerificationSession,
} from "../../types"

type Client = ControlPlaneDbClient

const HNS_CHALLENGE_TTL_MS = 24 * 60 * 60 * 1000
const SPACES_SESSION_TTL_MS = 24 * 60 * 60 * 1000
const SPACES_CHALLENGE_TTL_MS = 15 * 60 * 1000

type SelfSdkModule = {
  AllIds: unknown
  DefaultConfigStore: new (config: { minimumAge?: number }) => unknown
  SelfBackendVerifier: new (
    scope: string,
    callbackUrl: string,
    mockPassport: boolean,
    allIds: unknown,
    configStore: unknown,
    userIdType: string,
  ) => {
    verify: (
      attestationId: 1 | 2 | 3 | 4,
      proof: unknown,
      pubSignals: unknown[],
      userContextData: string,
    ) => Promise<{
      attestationId: string | number
      isValidDetails?: {
        isMinimumAgeValid?: boolean
      }
      discloseOutput?: {
        nationality?: string
        gender?: string
      }
    }>
  }
}

type SelfCallbackRequestBody = {
  attestationId?: number | string | null
  proof?: {
    a?: [string | number, string | number]
    b?: [[string | number, string | number], [string | number, string | number]]
    c?: [string | number, string | number]
  } | null
  pubSignals?: Array<string | number> | null
  publicSignals?: Array<string | number> | null
  userContextData?: string | null
}

let selfSdkModulePromise: Promise<SelfSdkModule> | null = null

function addHours(now: Date, hours: number): string {
  return new Date(now.getTime() + hours * 60 * 60 * 1000).toISOString()
}

function toDbBool(value: boolean | null): 0 | 1 | null {
  if (value == null) {
    return null
  }
  return value ? 1 : 0
}

function normalizeRootLabel(value: string): string {
  return value.trim().toLowerCase()
}

function normalizeSpacesRootLabel(value: string): string {
  const normalized = normalizeRootLabel(value)
  return normalized.startsWith("@") ? normalized.slice(1) : normalized
}

function getSelfVerificationConfig(env: Env) {
  return {
    scope: env.SELF_VERIFICATION_SCOPE?.trim() || "pirate-verification-v0",
    mockPassport: env.SELF_MOCK_PASSPORT === "true",
  }
}

function getPirateApiPublicOrigin(env: Env): string | null {
  const origin = env.PIRATE_API_PUBLIC_ORIGIN?.trim()
  return origin ? origin.replace(/\/+$/u, "") : null
}

function buildVerificationCallbackPath(verificationSessionId: string): string {
  return `/verification-sessions/${verificationSessionId}/callback`
}

function buildVerificationCallbackUrl(env: Env, verificationSessionId: string): string | null {
  const origin = getPirateApiPublicOrigin(env)
  return origin ? `${origin}${buildVerificationCallbackPath(verificationSessionId)}` : null
}

function requireVerificationCallbackUrl(
  env: Env,
  row: Pick<VerificationSessionRow, "upstream_session_ref" | "verification_session_id">,
): string {
  return row.upstream_session_ref
    ?? buildVerificationCallbackUrl(env, row.verification_session_id)
    ?? (() => {
      throw internalError("PIRATE_API_PUBLIC_ORIGIN is required for Self verification callbacks")
    })()
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null
  }

  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function buildSpacesChallenge(input: {
  namespaceVerificationSessionId: string
  normalizedRootLabel: string
  now: Date
}) {
  const issuedAt = input.now.toISOString()
  const expiresAt = new Date(input.now.getTime() + SPACES_CHALLENGE_TTL_MS).toISOString()
  const nonce = makeId("nonce")
  const message = `pirate-spaces-verification:${input.normalizedRootLabel}:${input.namespaceVerificationSessionId}:${nonce}`
  const digest = createHash("sha256").update(message).digest("hex")
  const payload = {
    message,
    digest,
    algorithm: "bip340_schnorr",
    domain: "pirate-spaces-verification",
    issued_at: issuedAt,
    expires_at: expiresAt,
    root_label: input.normalizedRootLabel,
  }

  return {
    challengeKind: "schnorr_sign" as const,
    challengePayloadJson: JSON.stringify(payload),
    challengeExpiresAt: expiresAt,
  }
}

function readChallengeDigest(row: NamespaceVerificationSessionRow): string | null {
  const payload = parseJsonObject(row.challenge_payload_json)
  return typeof payload?.digest === "string" && payload.digest.trim() !== ""
    ? payload.digest
    : null
}

function readChallengeMessage(row: NamespaceVerificationSessionRow): string | null {
  const payload = parseJsonObject(row.challenge_payload_json)
  return typeof payload?.message === "string" && payload.message.trim() !== ""
    ? payload.message
    : null
}

function buildSpacesObservationPayload(input: {
  normalizedRootLabel: string
  rootPubkey: string | null
  acceptedAnchorHeight: number | null
  acceptedAnchorBlockHash: string | null
  acceptedAnchorRootHash: string | null
  proofRootHash: string | null
  proofPayload: string | null
  failureReason: string | null
}) {
  return JSON.stringify({
    root_label: input.normalizedRootLabel,
    root_pubkey: input.rootPubkey,
    accepted_anchor_height: input.acceptedAnchorHeight,
    accepted_anchor_block_hash: input.acceptedAnchorBlockHash,
    accepted_anchor_root_hash: input.acceptedAnchorRootHash,
    proof_root_hash: input.proofRootHash,
    proof_payload: input.proofPayload,
    failure_reason: input.failureReason,
  })
}

async function insertNamespaceEvidenceBundle(
  client: Client,
  input: {
    namespaceVerificationSessionId: string
    namespaceVerificationId?: string | null
    family: "hns" | "spaces"
    normalizedRootLabel: string
    evidenceKind: string
    provider: string | null
    resolverPathJson?: string | null
    rawResponseJson?: string | null
    evidenceHash?: string | null
    observedAt: string
  },
): Promise<string> {
  const evidenceBundleId = makeId("nve")
  await client.execute({
    sql: `
      INSERT INTO namespace_verification_evidence_bundles (
        evidence_bundle_id, namespace_verification_session_id, namespace_verification_id, family, normalized_root_label,
        evidence_kind, provider, resolver_path_json, raw_response_json, evidence_hash, observed_at, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11, ?11)
    `,
    args: [
      evidenceBundleId,
      input.namespaceVerificationSessionId,
      input.namespaceVerificationId ?? null,
      input.family,
      input.normalizedRootLabel,
      input.evidenceKind,
      input.provider,
      input.resolverPathJson ?? null,
      input.rawResponseJson ?? null,
      input.evidenceHash ?? null,
      input.observedAt,
    ],
  })
  return evidenceBundleId
}

async function upsertNamespaceAssertion(
  client: Client,
  input: {
    namespaceVerificationSessionId: string
    namespaceVerificationId?: string | null
    family: "hns" | "spaces"
    assertionName: string
    assertionValue: 0 | 1 | null
    sourceEvidenceBundleId?: string | null
    nowString: string
  },
) {
  const scopeId = input.namespaceVerificationId ?? input.namespaceVerificationSessionId
  await client.execute({
    sql: `
      INSERT INTO namespace_verification_assertions (
        assertion_record_id, namespace_verification_session_id, namespace_verification_id, family, assertion_name,
        assertion_value, source_evidence_bundle_id, status, first_accepted_at, last_revalidated_at, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'accepted', ?8, ?8, ?8, ?8)
      ON CONFLICT (assertion_record_id) DO UPDATE SET
        namespace_verification_session_id = excluded.namespace_verification_session_id,
        namespace_verification_id = excluded.namespace_verification_id,
        family = excluded.family,
        assertion_name = excluded.assertion_name,
        assertion_value = excluded.assertion_value,
        source_evidence_bundle_id = excluded.source_evidence_bundle_id,
        status = excluded.status,
        last_revalidated_at = excluded.last_revalidated_at,
        updated_at = excluded.updated_at
    `,
    args: [
      `nva_${scopeId}_${input.assertionName}`,
      input.namespaceVerificationSessionId,
      input.namespaceVerificationId ?? null,
      input.family,
      input.assertionName,
      input.assertionValue,
      input.sourceEvidenceBundleId ?? null,
      input.nowString,
    ],
  })
}

async function upsertNamespaceCapability(
  client: Client,
  input: {
    namespaceVerificationSessionId: string
    namespaceVerificationId?: string | null
    family: "hns" | "spaces"
    capabilityName: string
    capabilityValue: 0 | 1 | null
    sourceEvidenceBundleId?: string | null
    nowString: string
  },
) {
  const scopeId = input.namespaceVerificationId ?? input.namespaceVerificationSessionId
  await client.execute({
    sql: `
      INSERT INTO namespace_verification_capabilities (
        capability_record_id, namespace_verification_session_id, namespace_verification_id, family, capability_name,
        capability_value, source_evidence_bundle_id, status, first_accepted_at, last_revalidated_at, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'accepted', ?8, ?8, ?8, ?8)
      ON CONFLICT (namespace_verification_session_id, capability_name, status) DO UPDATE SET
        namespace_verification_id = excluded.namespace_verification_id,
        family = excluded.family,
        capability_value = excluded.capability_value,
        source_evidence_bundle_id = excluded.source_evidence_bundle_id,
        last_revalidated_at = excluded.last_revalidated_at,
        updated_at = excluded.updated_at
    `,
    args: [
      `nvc_${scopeId}_${input.capabilityName}`,
      input.namespaceVerificationSessionId,
      input.namespaceVerificationId ?? null,
      input.family,
      input.capabilityName,
      input.capabilityValue,
      input.sourceEvidenceBundleId ?? null,
      input.nowString,
    ],
  })
}

async function insertOrReplaceNamespaceVerification(
  client: Client,
  input: {
    namespaceVerificationId: string
    namespaceVerificationSessionId: string
    userId: string
    family: "hns" | "spaces"
    normalizedRootLabel: string
    rootExists: 0 | 1
    rootControlVerified: 0 | 1 | null
    expiryHorizonSufficient: 0 | 1 | null
    routingEnabled: 0 | 1 | null
    pirateDnsAuthorityVerified: 0 | 1 | null
    clubAttachAllowed: 0 | 1
    pirateWebRoutingAllowed: 0 | 1 | null
    pirateSubdomainIssuanceAllowed: 0 | 1 | null
    controlClass: string | null
    operationClass: string | null
    observationProvider: string | null
    evidenceBundleRef: string | null
    acceptedAt: string
    expiresAt: string
    anchorHeight: number | null
    anchorBlockHash: string | null
    anchorRootHash: string | null
    proofRootHash: string | null
  },
) {
  await client.execute({
    sql: `
      INSERT INTO namespace_verifications (
        namespace_verification_id, source_namespace_verification_session_id, user_id, family, normalized_root_label,
        status, root_exists, root_control_verified, expiry_horizon_sufficient, routing_enabled,
        pirate_dns_authority_verified, club_attach_allowed, pirate_web_routing_allowed, pirate_subdomain_issuance_allowed,
        control_class, operation_class, observation_provider, evidence_bundle_ref, accepted_at, expires_at,
        anchor_height, anchor_block_hash, anchor_root_hash, proof_root_hash,
        created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5,
        'verified', ?6, ?7, ?8, ?9,
        ?10, ?11, ?12, ?13,
        ?14, ?15, ?16, ?17, ?18, ?19,
        ?20, ?21, ?22, ?23,
        ?18, ?18
      )
      ON CONFLICT (namespace_verification_id) DO UPDATE SET
        source_namespace_verification_session_id = excluded.source_namespace_verification_session_id,
        user_id = excluded.user_id,
        family = excluded.family,
        normalized_root_label = excluded.normalized_root_label,
        status = excluded.status,
        root_exists = excluded.root_exists,
        root_control_verified = excluded.root_control_verified,
        expiry_horizon_sufficient = excluded.expiry_horizon_sufficient,
        routing_enabled = excluded.routing_enabled,
        pirate_dns_authority_verified = excluded.pirate_dns_authority_verified,
        club_attach_allowed = excluded.club_attach_allowed,
        pirate_web_routing_allowed = excluded.pirate_web_routing_allowed,
        pirate_subdomain_issuance_allowed = excluded.pirate_subdomain_issuance_allowed,
        control_class = excluded.control_class,
        operation_class = excluded.operation_class,
        observation_provider = excluded.observation_provider,
        evidence_bundle_ref = excluded.evidence_bundle_ref,
        accepted_at = excluded.accepted_at,
        expires_at = excluded.expires_at,
        anchor_height = excluded.anchor_height,
        anchor_block_hash = excluded.anchor_block_hash,
        anchor_root_hash = excluded.anchor_root_hash,
        proof_root_hash = excluded.proof_root_hash,
        updated_at = excluded.updated_at
    `,
    args: [
      input.namespaceVerificationId,
      input.namespaceVerificationSessionId,
      input.userId,
      input.family,
      input.normalizedRootLabel,
      input.rootExists,
      input.rootControlVerified,
      input.expiryHorizonSufficient,
      input.routingEnabled,
      input.pirateDnsAuthorityVerified,
      input.clubAttachAllowed,
      input.pirateWebRoutingAllowed,
      input.pirateSubdomainIssuanceAllowed,
      input.controlClass,
      input.operationClass,
      input.observationProvider,
      input.evidenceBundleRef,
      input.acceptedAt,
      input.expiresAt,
      input.anchorHeight,
      input.anchorBlockHash,
      input.anchorRootHash,
      input.proofRootHash,
    ],
  })
}

function getVeryVerifyUrl(env: Env): string {
  return env.VERY_VERIFY_URL?.trim() || "https://verify.very.org/api/v1/verify"
}

function parseRequestedCapabilities(raw: string): Array<"unique_human" | "age_over_18" | "nationality" | "gender"> {
  return JSON.parse(raw) as Array<"unique_human" | "age_over_18" | "nationality" | "gender">
}

const VALID_VERIFICATION_INTENTS = new Set<NonNullable<StartVerificationSessionRequest["verification_intent"]>>([
  "profile_verification",
  "community_creation",
  "ucommunity_join",
  "post_access_18_plus",
  "commerce_pricing",
  "qualifier_disclosure",
])

const SUPPORTED_REQUESTED_CAPABILITIES = new Set([
  "unique_human",
  "age_over_18",
  "nationality",
  "gender",
] as const)

const VALID_REQUESTED_CAPABILITIES_BY_PROVIDER = {
  self: new Set(["unique_human", "age_over_18", "nationality", "gender"]),
  very: new Set(["unique_human"]),
} as const

function normalizeRequestedCapabilities(input: {
  provider: "self" | "very"
  requestedCapabilities?: Array<"unique_human" | "age_over_18" | "nationality" | "gender"> | null
}): Array<"unique_human" | "age_over_18" | "nationality" | "gender"> {
  const rawCapabilities = input.requestedCapabilities ?? ["unique_human"]
  if (rawCapabilities.length === 0) {
    throw badRequestError("requested_capabilities must contain at least one capability")
  }

  const validCapabilities = VALID_REQUESTED_CAPABILITIES_BY_PROVIDER[input.provider]
  const normalized: Array<"unique_human" | "age_over_18" | "nationality" | "gender"> = []
  for (const capability of rawCapabilities) {
    if (!SUPPORTED_REQUESTED_CAPABILITIES.has(capability)) {
      throw badRequestError(`Unsupported requested capability ${String(capability)}`)
    }
    if (!validCapabilities.has(capability)) {
      throw badRequestError(`${input.provider} does not support requested capability ${capability}`)
    }
    if (!normalized.includes(capability)) {
      normalized.push(capability)
    }
  }

  if (!normalized.includes("unique_human")) {
    normalized.unshift("unique_human")
  }

  return normalized
}

function normalizeVerificationIntent(
  value: StartVerificationSessionRequest["verification_intent"] | undefined,
): StartVerificationSessionRequest["verification_intent"] | null {
  if (value == null) {
    return null
  }
  if (!VALID_VERIFICATION_INTENTS.has(value)) {
    throw badRequestError(`Unsupported verification intent ${String(value)}`)
  }
  return value
}

function normalizePolicyId(value: string | null | undefined): string | null {
  if (value == null) {
    return null
  }
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

async function normalizeNationalityValue(rawValue: string | null | undefined): Promise<string | null> {
  if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
    return null
  }

  const normalized = rawValue.trim().toUpperCase()
  if (/^[A-Z]{2}$/u.test(normalized)) {
    return normalized
  }

  if (/^[A-Z]{3}$/u.test(normalized)) {
    const alpha2 = ISO_3_TO_2[normalized]
    return typeof alpha2 === "string" ? alpha2 : null
  }

  return null
}

const ISO_3_TO_2: Record<string, string> = {
  AFG: "AF", ALB: "AL", DZA: "DZ", ASM: "AS", AND: "AD", AGO: "AO", AIA: "AI", ATA: "AQ", ATG: "AG", ARG: "AR", ARM: "AM", ABW: "AW", AUS: "AU", AUT: "AT", AZE: "AZ", BHS: "BS", BHR: "BH", BGD: "BD", BRB: "BB", BLR: "BY", BEL: "BE", BLZ: "BZ", BEN: "BJ", BMU: "BM", BTN: "BT", BOL: "BO", BES: "BQ", BIH: "BA", BWA: "BW", BVT: "BV", BRA: "BR", IOT: "IO", BRN: "BN", BGR: "BG", BFA: "BF", BDI: "BI", CPV: "CV", KHM: "KH", CMR: "CM", CAN: "CA", CYM: "KY", CAF: "CF", TCD: "TD", CHL: "CL", CHN: "CN", CXR: "CX", CCK: "CC", COL: "CO", COM: "KM", COG: "CG", COD: "CD", COK: "CK", CRI: "CR", CIV: "CI", HRV: "HR", CUB: "CU", CUW: "CW", CYP: "CY", CZE: "CZ", DNK: "DK", DJI: "DJ", DMA: "DM", DOM: "DO", ECU: "EC", EGY: "EG", SLV: "SV", GNQ: "GQ", ERI: "ER", EST: "EE", SWZ: "SZ", ETH: "ET", FLK: "FK", FRO: "FO", FJI: "FJ", FIN: "FI", FRA: "FR", GUF: "GF", PYF: "PF", ATF: "TF", GAB: "GA", GMB: "GM", GEO: "GE", DEU: "DE", GHA: "GH", GIB: "GI", GRC: "GR", GRL: "GL", GRD: "GD", GLP: "GP", GUM: "GU", GTM: "GT", GGY: "GG", GIN: "GN", GNB: "GW", HTI: "HT", HMD: "HM", VAT: "VA", HND: "HN", HKG: "HK", HUN: "HU", ISL: "IS", IND: "IN", IDN: "ID", IRN: "IR", IRQ: "IQ", IRL: "IE", IMN: "IM", ISR: "IL", ITA: "IT", JAM: "JM", JPN: "JP", JEY: "JE", JOR: "JO", KAZ: "KZ", KEN: "KE", KIR: "KI", PRK: "KP", KOR: "KR", KWT: "KW", KGZ: "KG", LAO: "LA", LVA: "LV", LBN: "LB", LSO: "LS", LBR: "LR", LBY: "LY", LIE: "LI", LTU: "LT", LUX: "LU", MAC: "MO", MDG: "MG", MWI: "MW", MYS: "MY", MDV: "MV", MLI: "ML", MLT: "MT", MHL: "MH", MTQ: "MQ", MRT: "MR", MUS: "MU", MYT: "YT", MEX: "MX", FSM: "FM", MDA: "MD", MCO: "MC", MNG: "MN", MNE: "ME", MSR: "MS", MAR: "MA", MOZ: "MZ", MMR: "MM", NAM: "NA", NRU: "NR", NPL: "NP", NLD: "NL", NCL: "NC", NZL: "NZ", NIC: "NI", NER: "NE", NGA: "NG", NIU: "NU", NFK: "NF", MKD: "MK", MNP: "MP", NOR: "NO", OMN: "OM", PAK: "PK", PLW: "PW", PSE: "PS", PAN: "PA", PNG: "PG", PRY: "PY", PER: "PE", PHL: "PH", PCN: "PN", POL: "PL", PRT: "PT", PRI: "PR", QAT: "QA", REU: "RE", ROU: "RO", RUS: "RU", RWA: "RW", BLM: "BL", SHN: "SH", KNA: "KN", LCA: "LC", MAF: "MF", SPM: "PM", VCT: "VC", WSM: "WS", SMR: "SM", STP: "ST", SAU: "SA", SEN: "SN", SRB: "RS", SYC: "SC", SLE: "SL", SGP: "SG", SXM: "SX", SVK: "SK", SVN: "SI", SLB: "SB", SOM: "SO", ZAF: "ZA", SGS: "GS", SSD: "SS", ESP: "ES", LKA: "LK", SDN: "SD", SUR: "SR", SJM: "SJ", SZW: "SZ", SWE: "SE", CHE: "CH", SYR: "SY", TWN: "TW", TJK: "TJ", TZA: "TZ", THA: "TH", TLS: "TL", TGO: "TG", TKL: "TK", TON: "TO", TTO: "TT", TUN: "TN", TUR: "TR", TKM: "TM", TCA: "TC", TUV: "TV", UGA: "UG", UKR: "UA", ARE: "AE", GBR: "GB", USA: "US", UMI: "UM", URY: "UY", UZB: "UZ", VUT: "VU", VEN: "VE", VNM: "VN", VGB: "VG", VIR: "VI", WLF: "WF", ESH: "EH", YEM: "YE", ZMB: "ZM", ZWE: "ZW",
}

function parseSelfCallbackRequestBody(value: unknown) {
  const body = (value ?? {}) as SelfCallbackRequestBody
  const attestationIdRaw = body.attestationId
  const attestationId = typeof attestationIdRaw === "number"
    ? attestationIdRaw
    : typeof attestationIdRaw === "string" && attestationIdRaw.trim() !== ""
      ? Number(attestationIdRaw)
      : NaN
  const proof = body.proof
  const pubSignals = Array.isArray(body.pubSignals)
    ? body.pubSignals
    : Array.isArray(body.publicSignals)
      ? body.publicSignals
      : null
  const userContextData = typeof body.userContextData === "string" ? body.userContextData : null

  if (!Number.isInteger(attestationId) || !proof || !Array.isArray(pubSignals) || !userContextData) {
    throw badRequestError("Self callback payload is invalid")
  }

  return {
    attestationId,
    proof,
    pubSignals,
    userContextData,
  }
}

async function loadSelfSdk(): Promise<SelfSdkModule> {
  const importBySpecifier = async (specifier: string): Promise<unknown> => await import(specifier)
  const fallbackSpecifier = "../../../../../../pirate-web/node_modules/@selfxyz/core/dist/index.js"

  if (!selfSdkModulePromise) {
    selfSdkModulePromise = importBySpecifier("@selfxyz/core")
      .catch(async () => await importBySpecifier(fallbackSpecifier))
      .then((module) => module as SelfSdkModule)
      .catch(() => {
        selfSdkModulePromise = null
        throw notImplementedError("Self verification backend is not installed in this runtime")
      })
  }

  return await selfSdkModulePromise
}

async function verifySelfCallback(input: {
  env: Env
  row: VerificationSessionRow
  requestBody: unknown
}) {
  const parsed = parseSelfCallbackRequestBody(input.requestBody)
  const config = getSelfVerificationConfig(input.env)
  const { AllIds, DefaultConfigStore, SelfBackendVerifier } = await loadSelfSdk()
  const requestedCapabilities = parseRequestedCapabilities(input.row.requested_capabilities_json)
  const verifier = new SelfBackendVerifier(
    config.scope,
    requireVerificationCallbackUrl(input.env, input.row),
    config.mockPassport,
    AllIds,
    new DefaultConfigStore({
      minimumAge: requestedCapabilities.includes("age_over_18") ? 18 : undefined,
    }),
    "hex",
  )
  const verification = await verifier.verify(
    parsed.attestationId as 1 | 2 | 3 | 4,
    parsed.proof,
    parsed.pubSignals,
    parsed.userContextData,
  )

  return {
    attestationId: String(verification.attestationId),
    proofHash: createHash("sha256").update(JSON.stringify({
      attestationId: parsed.attestationId,
      proof: parsed.proof,
      pubSignals: parsed.pubSignals,
      userContextData: parsed.userContextData,
    })).digest("hex"),
    requestedCapabilities,
    isMinimumAgeValid: verification.isValidDetails?.isMinimumAgeValid === true,
    nationality: await normalizeNationalityValue(verification.discloseOutput?.nationality),
    gender: typeof verification.discloseOutput?.gender === "string" && verification.discloseOutput.gender.trim().length > 0
      ? verification.discloseOutput.gender.trim().toUpperCase()
      : null,
  }
}

async function verifyVeryProof(input: {
  proof: string
  env: Env
}): Promise<{ proofHash: string }> {
  let response: Response
  try {
    response = await fetch(getVeryVerifyUrl(input.env), {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        proof: input.proof,
      }),
    })
  } catch {
    throw internalError("Very proof verification failed")
  }

  let body: { status?: string } | null = null
  try {
    body = await response.json() as { status?: string }
  } catch {
    body = null
  }

  if (!response.ok || body?.status !== "valid") {
    throw verificationRequired("Very proof was not valid")
  }

  return {
    proofHash: createHash("sha256").update(input.proof).digest("hex"),
  }
}

async function getVerificationSessionRowForUser(
  client: Client,
  verificationSessionId: string,
  userId: string,
): Promise<VerificationSessionRow | null> {
  const row = await firstRow(client, {
    sql: `
      SELECT verification_session_id, user_id, provider, wallet_attachment_id, requested_capabilities_json,
             verification_intent, policy_id,
             status, upstream_session_ref, result_ref, failure_code, completed_at, expires_at, created_at, updated_at
      FROM verification_sessions
      WHERE verification_session_id = ?1
        AND user_id = ?2
      LIMIT 1
    `,
    args: [verificationSessionId, userId],
  })

  return row ? toVerificationSessionRow(row) : null
}

async function getVerificationSessionRowById(
  client: Client,
  verificationSessionId: string,
): Promise<VerificationSessionRow | null> {
  const row = await firstRow(client, {
    sql: `
      SELECT verification_session_id, user_id, provider, wallet_attachment_id, requested_capabilities_json,
             verification_intent, policy_id,
             status, upstream_session_ref, result_ref, failure_code, completed_at, expires_at, created_at, updated_at
      FROM verification_sessions
      WHERE verification_session_id = ?1
      LIMIT 1
    `,
    args: [verificationSessionId],
  })

  return row ? toVerificationSessionRow(row) : null
}

async function getAttestationBySourceSessionId(
  client: Client,
  verificationSessionId: string,
  userId: string,
): Promise<UserAttestationRow | null> {
  const row = await firstRow(client, {
    sql: `
      SELECT user_attestation_id, capability_key, status, verified_at, expires_at
      FROM user_attestations
      WHERE source_verification_session_id = ?1
        AND user_id = ?2
      ORDER BY created_at DESC
      LIMIT 1
    `,
    args: [verificationSessionId, userId],
  })

  return row ? toUserAttestationRow(row) : null
}

async function getNamespaceVerificationSessionRowForUser(
  client: Client,
  namespaceVerificationSessionId: string,
  userId: string,
): Promise<NamespaceVerificationSessionRow | null> {
  const row = await firstRow(client, {
    sql: `
      SELECT namespace_verification_session_id, namespace_verification_id, user_id, family, submitted_root_label,
             normalized_root_label, status, challenge_host, challenge_txt_value, challenge_expires_at,
             challenge_kind, challenge_payload_json,
             root_exists, root_control_verified, expiry_horizon_sufficient, routing_enabled,
             pirate_dns_authority_verified, club_attach_allowed, pirate_web_routing_allowed,
             pirate_subdomain_issuance_allowed, control_class, operation_class, observation_provider,
             evidence_bundle_ref, failure_reason, accepted_at, expires_at,
             anchor_height, anchor_block_hash, anchor_root_hash, proof_root_hash,
             created_at, updated_at
      FROM namespace_verification_sessions
      WHERE namespace_verification_session_id = ?1
        AND user_id = ?2
      LIMIT 1
    `,
    args: [namespaceVerificationSessionId, userId],
  })

  return row ? toNamespaceVerificationSessionRow(row) : null
}

async function getLatestNamespaceVerificationSessionRowForRoot(
  client: Client,
  input: {
    userId: string
    family: "hns" | "spaces"
    normalizedRootLabel: string
  },
): Promise<NamespaceVerificationSessionRow | null> {
  const row = await firstRow(client, {
    sql: `
      SELECT namespace_verification_session_id, namespace_verification_id, user_id, family, submitted_root_label,
             normalized_root_label, status, challenge_host, challenge_txt_value, challenge_expires_at,
             challenge_kind, challenge_payload_json,
             root_exists, root_control_verified, expiry_horizon_sufficient, routing_enabled,
             pirate_dns_authority_verified, club_attach_allowed, pirate_web_routing_allowed,
             pirate_subdomain_issuance_allowed, control_class, operation_class, observation_provider,
             evidence_bundle_ref, failure_reason, accepted_at, expires_at,
             anchor_height, anchor_block_hash, anchor_root_hash, proof_root_hash,
             created_at, updated_at
      FROM namespace_verification_sessions
      WHERE user_id = ?1
        AND family = ?2
        AND normalized_root_label = ?3
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1
    `,
    args: [input.userId, input.family, input.normalizedRootLabel],
  })

  return row ? toNamespaceVerificationSessionRow(row) : null
}

async function getNamespaceVerificationRowForUser(
  client: Client,
  namespaceVerificationId: string,
  userId: string,
): Promise<NamespaceVerificationRow | null> {
  const row = await firstRow(client, {
    sql: `
      SELECT namespace_verification_id, user_id, family, normalized_root_label, status,
             root_exists, root_control_verified, expiry_horizon_sufficient, routing_enabled,
             pirate_dns_authority_verified, club_attach_allowed, pirate_web_routing_allowed,
             pirate_subdomain_issuance_allowed, control_class, operation_class, observation_provider,
             evidence_bundle_ref, accepted_at, expires_at,
             anchor_height, anchor_block_hash, anchor_root_hash, proof_root_hash,
             created_at, updated_at
      FROM namespace_verifications
      WHERE namespace_verification_id = ?1
        AND user_id = ?2
      LIMIT 1
    `,
    args: [namespaceVerificationId, userId],
  })

  return row ? toNamespaceVerificationRow(row) : null
}

export async function startVerificationSession(
  client: Client,
  input: {
    userId: string
    provider: "self" | "very"
    walletAttachmentId?: string | null
    requestedCapabilities?: Array<"unique_human" | "age_over_18" | "nationality" | "gender"> | null
    verificationIntent?: StartVerificationSessionRequest["verification_intent"]
    policyId?: string | null
    env?: Env
  },
): Promise<VerificationSession> {
  const now = new Date()
  const createdAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString()
  const verificationSessionId = makeId("ver")
  const requestedCapabilities = normalizeRequestedCapabilities({
    provider: input.provider,
    requestedCapabilities: input.requestedCapabilities,
  })
  const verificationIntent = normalizeVerificationIntent(input.verificationIntent)
  const policyId = normalizePolicyId(input.policyId)
  const policyResolved = resolveVerificationSessionPolicy({
    provider: input.provider,
    requestedCapabilities,
    verificationIntent,
    policyId,
  })

  await client.execute({
    sql: `
      INSERT INTO verification_sessions (
        verification_session_id, user_id, provider, wallet_attachment_id, session_kind, requested_capabilities_json,
        verification_intent, policy_id, status, upstream_session_ref, result_ref, failure_code, started_at,
        completed_at, expires_at, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, 'identity_proof', ?5, ?6, ?7, 'pending', ?8, NULL, NULL, ?9, NULL, ?10, ?9, ?9)
    `,
    args: [
      verificationSessionId,
      input.userId,
      input.provider,
      input.walletAttachmentId ?? null,
      JSON.stringify(policyResolved.requestedCapabilities),
      policyResolved.verificationIntent ?? null,
      policyResolved.policyId,
      input.provider === "self" && input.env ? buildVerificationCallbackUrl(input.env, verificationSessionId) : null,
      createdAt,
      expiresAt,
    ],
  })

  const row = await getVerificationSessionRowForUser(client, verificationSessionId, input.userId)
  if (!row) {
    throw internalError("Verification session row is missing after creation")
  }
  return serializeVerificationSession({ row, attestationRow: null, env: input.env })
}

export async function getVerificationSession(
  client: Client,
  verificationSessionId: string,
  userId: string,
  env?: Env,
): Promise<VerificationSession | null> {
  const row = await getVerificationSessionRowForUser(client, verificationSessionId, userId)
  if (!row) {
    return null
  }
  const attestationRow = await getAttestationBySourceSessionId(client, verificationSessionId, userId)
  return serializeVerificationSession({ row, attestationRow, env })
}

export async function completeVerificationSession(
  client: Client,
  input: {
    verificationSessionId: string
    userId: string
    attestationId?: string | null
    proofHash?: string | null
    proof?: string | null
    requestedCapabilities?: Array<"unique_human" | "age_over_18" | "nationality" | "gender"> | null
    selfDisclosures?: {
      isMinimumAgeValid?: boolean | null
      nationality?: string | null
      gender?: string | null
    } | null
    env: Env
  },
): Promise<VerificationSession | null> {
  const row = await getVerificationSessionRowForUser(client, input.verificationSessionId, input.userId)
  if (!row) {
    return null
  }

  const now = new Date()
  const updatedAt = now.toISOString()
  const attestationId = input.attestationId?.trim() || makeId("att")
  const expiresAt = row.expires_at ?? new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()
  const userRow = await getUserRow(client, input.userId)
  if (!userRow) {
    throw internalError("User row missing while completing verification session")
  }
  const requestedCapabilities = input.requestedCapabilities ?? parseRequestedCapabilities(row.requested_capabilities_json)

  let resolvedProofHash = input.proofHash ?? null
  let mechanism = row.provider === "self" ? "self-sdk" : "session_complete"
  if (row.provider === "very") {
    if (!input.proof?.trim()) {
      throw badRequestError("Verification proof is required")
    }
    const verified = await verifyVeryProof({
      proof: input.proof.trim(),
      env: input.env,
    })
    resolvedProofHash = verified.proofHash
    mechanism = "very-widget"
  }

  const capabilities = parseVerificationCapabilities(userRow.verification_capabilities_json)
  capabilities.unique_human = {
    state: "verified",
    provider: row.provider === "self" || row.provider === "very" ? row.provider : null,
    proof_type: "unique_human",
    mechanism,
    verified_at: updatedAt,
  }

  if (row.provider === "self" && requestedCapabilities.includes("age_over_18") && input.selfDisclosures?.isMinimumAgeValid === true) {
    capabilities.age_over_18 = {
      state: "verified",
      provider: "self",
      proof_type: "age_over_18",
      mechanism: "self-sdk",
      verified_at: updatedAt,
    }
  }

  if (row.provider === "self" && requestedCapabilities.includes("nationality") && typeof input.selfDisclosures?.nationality === "string") {
    capabilities.nationality = {
      state: "verified",
      value: input.selfDisclosures.nationality,
      provider: "self",
      proof_type: "nationality",
      mechanism: "zk-nationality",
      verified_at: updatedAt,
    }
  }

  if (
    row.provider === "self"
    && requestedCapabilities.includes("gender")
    && (input.selfDisclosures?.gender === "M" || input.selfDisclosures?.gender === "F")
  ) {
    capabilities.gender = {
      state: "verified",
      value: input.selfDisclosures.gender,
      provider: "self",
      proof_type: "gender",
      mechanism: "self-sdk",
      verified_at: updatedAt,
    }
  }

  await client.batch([
    {
      sql: `
        UPDATE verification_sessions
        SET status = 'verified',
            result_ref = ?2,
            failure_code = NULL,
            completed_at = ?3,
            updated_at = ?3
        WHERE verification_session_id = ?1
      `,
      args: [input.verificationSessionId, resolvedProofHash, updatedAt],
    },
    {
      sql: `
        INSERT INTO user_attestations (
          user_attestation_id, user_id, source_verification_session_id, provider, attestation_type,
          capability_key, status, value_json, verified_at, expires_at, revoked_at, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, 'unique_human', 'unique_human', 'accepted', ?5, ?6, ?7, NULL, ?6, ?6)
      `,
      args: [attestationId, input.userId, input.verificationSessionId, row.provider, JSON.stringify({ state: "verified" }), updatedAt, expiresAt],
    },
    {
      sql: `
        UPDATE users
        SET verification_state = 'verified',
            capability_provider = ?2,
            verification_capabilities_json = ?3,
            verified_at = ?4,
            nationality = ?6,
            current_verification_session_id = ?1,
            updated_at = ?4
        WHERE user_id = ?5
      `,
      args: [
        input.verificationSessionId,
        row.provider,
        JSON.stringify(capabilities),
        updatedAt,
        input.userId,
        capabilities.nationality.state === "verified" ? capabilities.nationality.value ?? null : null,
      ],
    },
  ], "write")

  return getVerificationSession(client, input.verificationSessionId, input.userId, input.env)
}

export async function completeVerificationSessionByCallback(
  client: Client,
  input: {
    verificationSessionId: string
    requestBody: unknown
    env: Env
  },
): Promise<VerificationSession | null> {
  const row = await getVerificationSessionRowById(client, input.verificationSessionId)
  if (!row) {
    return null
  }

  if (row.provider !== "self") {
    throw notImplementedError(`Secure ${row.provider} callback verification is not implemented`)
  }

  if (row.status === "verified") {
    return getVerificationSession(client, row.verification_session_id, row.user_id, input.env)
  }

  if (row.status !== "pending") {
    throw conflictError("Verification session is not pending")
  }

  const verified = await verifySelfCallback({
    env: input.env,
    row,
    requestBody: input.requestBody,
  })

  return await completeVerificationSession(client, {
    verificationSessionId: row.verification_session_id,
    userId: row.user_id,
    attestationId: verified.attestationId,
    proofHash: verified.proofHash,
    requestedCapabilities: verified.requestedCapabilities,
    selfDisclosures: {
      isMinimumAgeValid: verified.isMinimumAgeValid,
      nationality: verified.nationality,
      gender: verified.gender === "M" || verified.gender === "F" ? verified.gender : null,
    },
    env: input.env,
  })
}

export async function startNamespaceVerificationSession(
  client: Client,
  input: {
    userId: string
    family: "hns" | "spaces"
    rootLabel: string
    env: Env
  },
): Promise<NamespaceVerificationSession> {
  const userRow = await getUserRow(client, input.userId)
  if (!userRow) {
    throw internalError("User row missing while starting namespace verification session")
  }
  const capabilities = parseVerificationCapabilities(userRow.verification_capabilities_json)
  if (capabilities.unique_human.state !== "verified") {
    throw verificationRequired("unique_human verification is required")
  }

  const now = new Date()
  const createdAt = now.toISOString()
  const normalizedRootLabel = input.family === "spaces"
    ? normalizeSpacesRootLabel(input.rootLabel)
    : normalizeRootLabel(input.rootLabel)
  const existingRow = await getLatestNamespaceVerificationSessionRowForRoot(client, {
    userId: input.userId,
    family: input.family,
    normalizedRootLabel,
  })

  if (existingRow && Date.parse(existingRow.expires_at) > now.getTime()) {
    return serializeNamespaceVerificationSession(existingRow)
  }

  if (input.family === "spaces") {
    const sessionId = makeId("nvs")
    const expiresAt = new Date(now.getTime() + SPACES_SESSION_TTL_MS).toISOString()
    const inspection = await inspectSpacesNamespace({
      env: input.env,
      normalizedRootLabel,
    })
    const challenge = inspection.rootExists && inspection.rootKeyProofVerified && inspection.anchorFreshEnough
      ? buildSpacesChallenge({
          namespaceVerificationSessionId: sessionId,
          normalizedRootLabel,
          now,
        })
      : null
    const status: NamespaceVerificationSessionRow["status"] = !inspection.rootExists
      ? "failed"
      : !inspection.rootKeyProofVerified
        ? "failed"
        : !inspection.anchorFreshEnough
          ? "failed"
          : "challenge_pending"
    const failureReason = !inspection.rootExists
      ? inspection.failureReason ?? "root_not_found"
      : !inspection.rootKeyProofVerified
        ? inspection.failureReason ?? "proof_not_verifiable"
        : !inspection.anchorFreshEnough
          ? inspection.failureReason ?? "anchor_set_stale"
          : null
    await client.execute({
      sql: `
        INSERT INTO namespace_verification_sessions (
          namespace_verification_session_id, namespace_verification_id, user_id, family, submitted_root_label,
          normalized_root_label, status, challenge_host, challenge_txt_value, challenge_expires_at,
          challenge_kind, challenge_payload_json,
          root_exists, root_control_verified, expiry_horizon_sufficient, routing_enabled,
          pirate_dns_authority_verified, club_attach_allowed, pirate_web_routing_allowed,
          pirate_subdomain_issuance_allowed, control_class, operation_class, observation_provider,
          evidence_bundle_ref, failure_reason, accepted_at, expires_at,
          anchor_height, anchor_block_hash, anchor_root_hash, proof_root_hash,
        created_at, updated_at
      ) VALUES (
        ?1, NULL, ?2, 'spaces', ?3,
          ?4, ?5, NULL, NULL, ?6,
          ?7, ?8,
          ?9, NULL, NULL, NULL,
          NULL, NULL, NULL,
          NULL, ?10, ?11, ?12,
          ?13, ?14, NULL, ?15,
          ?16, ?17, ?18, ?19,
        ?20, ?20
      )
    `,
      args: [
        sessionId,
        input.userId,
        input.rootLabel,
        normalizedRootLabel,
        status,
        challenge?.challengeExpiresAt ?? null,
        challenge?.challengeKind ?? null,
        challenge?.challengePayloadJson ?? null,
        toDbBool(inspection.rootExists),
        inspection.controlClass ?? "single_holder_root",
        inspection.operationClass ?? "owner_managed_namespace",
        inspection.observationProvider,
        null,
        failureReason,
        expiresAt,
        inspection.acceptedAnchorHeight,
        inspection.acceptedAnchorBlockHash,
        inspection.acceptedAnchorRootHash,
        inspection.proofRootHash,
        createdAt,
      ],
    })
    const proofEvidenceBundleId = await insertNamespaceEvidenceBundle(client, {
      namespaceVerificationSessionId: sessionId,
      family: "spaces",
      normalizedRootLabel,
      evidenceKind: "space_proof_snapshot",
      provider: inspection.observationProvider,
      rawResponseJson: buildSpacesObservationPayload({
        normalizedRootLabel,
        rootPubkey: inspection.rootPubkey,
        acceptedAnchorHeight: inspection.acceptedAnchorHeight,
        acceptedAnchorBlockHash: inspection.acceptedAnchorBlockHash,
        acceptedAnchorRootHash: inspection.acceptedAnchorRootHash,
        proofRootHash: inspection.proofRootHash,
        proofPayload: inspection.proofPayload,
        failureReason: inspection.failureReason,
      }),
      evidenceHash: inspection.proofRootHash,
      observedAt: createdAt,
    })
    await client.execute({
      sql: `
        UPDATE namespace_verification_sessions
        SET evidence_bundle_ref = ?2,
            updated_at = ?3
        WHERE namespace_verification_session_id = ?1
      `,
      args: [sessionId, proofEvidenceBundleId, createdAt],
    })

    await upsertNamespaceAssertion(client, {
      namespaceVerificationSessionId: sessionId,
      family: "spaces",
      assertionName: "root_exists",
      assertionValue: toDbBool(inspection.rootExists),
      sourceEvidenceBundleId: proofEvidenceBundleId,
      nowString: createdAt,
    })
    await upsertNamespaceAssertion(client, {
      namespaceVerificationSessionId: sessionId,
      family: "spaces",
      assertionName: "root_key_proof_verified",
      assertionValue: toDbBool(inspection.rootKeyProofVerified),
      sourceEvidenceBundleId: proofEvidenceBundleId,
      nowString: createdAt,
    })
    await upsertNamespaceAssertion(client, {
      namespaceVerificationSessionId: sessionId,
      family: "spaces",
      assertionName: "anchor_fresh_enough",
      assertionValue: toDbBool(inspection.anchorFreshEnough),
      sourceEvidenceBundleId: proofEvidenceBundleId,
      nowString: createdAt,
    })

    const row = await getNamespaceVerificationSessionRowForUser(client, sessionId, input.userId)
    if (!row) {
      throw internalError("Namespace verification session row is missing after creation")
    }
    return serializeNamespaceVerificationSession(row)
  }

  const sessionId = makeId("nvs")
  const challengeHost = `_pirate.${normalizedRootLabel}`
  const challengeTxtValue = `pirate-verification=${sessionId}`
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()
  const challengeExpiresAt = new Date(now.getTime() + HNS_CHALLENGE_TTL_MS).toISOString()

  await client.execute({
    sql: `
      INSERT INTO namespace_verification_sessions (
        namespace_verification_session_id, namespace_verification_id, user_id, family, submitted_root_label,
        normalized_root_label, status, challenge_host, challenge_txt_value, challenge_expires_at,
        challenge_kind, challenge_payload_json,
        root_exists, root_control_verified, expiry_horizon_sufficient, routing_enabled,
        pirate_dns_authority_verified, club_attach_allowed, pirate_web_routing_allowed,
        pirate_subdomain_issuance_allowed, control_class, operation_class, observation_provider,
        evidence_bundle_ref, failure_reason, accepted_at, expires_at,
        anchor_height, anchor_block_hash, anchor_root_hash, proof_root_hash,
        created_at, updated_at
      ) VALUES (
        ?1, NULL, ?2, ?3, ?4, ?5, 'challenge_required', ?6, ?7, ?8,
        'dns_txt', NULL,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'local_stub',
        NULL, NULL, NULL, ?9,
        NULL, NULL, NULL, NULL,
        ?10, ?10
      )
    `,
    args: [sessionId, input.userId, input.family, input.rootLabel, normalizedRootLabel, challengeHost, challengeTxtValue, challengeExpiresAt, expiresAt, createdAt],
  })

  const row = await getNamespaceVerificationSessionRowForUser(client, sessionId, input.userId)
  if (!row) {
    throw internalError("Namespace verification session row is missing after creation")
  }
  return serializeNamespaceVerificationSession(row)
}

export async function getNamespaceVerificationSession(
  client: Client,
  namespaceVerificationSessionId: string,
  userId: string,
): Promise<NamespaceVerificationSession | null> {
  const row = await getNamespaceVerificationSessionRowForUser(client, namespaceVerificationSessionId, userId)
  return row ? serializeNamespaceVerificationSession(row) : null
}

export async function completeNamespaceVerificationSession(
  client: Client,
  env: Env,
  input: {
    namespaceVerificationSessionId: string
    userId: string
    restartChallenge?: boolean | null
    signaturePayload?: {
      signature?: string | null
      algorithm?: string | null
      signer_pubkey?: string | null
      digest?: string | null
    } | null
  },
): Promise<NamespaceVerificationSession | null> {
  const row = await getNamespaceVerificationSessionRowForUser(client, input.namespaceVerificationSessionId, input.userId)
  if (!row) {
    return null
  }

  if (row.status === "verified") {
    return serializeNamespaceVerificationSession(row)
  }

  const now = new Date()
  const updatedAt = now.toISOString()
  if (row.family === "spaces") {
    const normalizedRootLabel = row.normalized_root_label ?? normalizeSpacesRootLabel(row.submitted_root_label)
    const userRow = await getUserRow(client, input.userId)
    if (!userRow) {
      throw internalError("User row missing while completing namespace verification session")
    }
    const creatorUniqueHumanVerified = parseVerificationCapabilities(userRow.verification_capabilities_json).unique_human.state === "verified"

    if (input.restartChallenge || row.status === "draft" || row.status === "inspecting" || row.status === "failed") {
      const inspection = await inspectSpacesNamespace({
        env,
        normalizedRootLabel,
      })
      const challenge = inspection.rootExists && inspection.rootKeyProofVerified && inspection.anchorFreshEnough
        ? buildSpacesChallenge({
            namespaceVerificationSessionId: row.namespace_verification_session_id,
            normalizedRootLabel,
            now,
          })
        : null
      const proofEvidenceBundleId = await insertNamespaceEvidenceBundle(client, {
        namespaceVerificationSessionId: row.namespace_verification_session_id,
        namespaceVerificationId: row.namespace_verification_id,
        family: "spaces",
        normalizedRootLabel,
        evidenceKind: "space_proof_snapshot",
        provider: inspection.observationProvider,
        rawResponseJson: buildSpacesObservationPayload({
          normalizedRootLabel,
          rootPubkey: inspection.rootPubkey,
          acceptedAnchorHeight: inspection.acceptedAnchorHeight,
          acceptedAnchorBlockHash: inspection.acceptedAnchorBlockHash,
          acceptedAnchorRootHash: inspection.acceptedAnchorRootHash,
          proofRootHash: inspection.proofRootHash,
          proofPayload: inspection.proofPayload,
          failureReason: inspection.failureReason,
        }),
        evidenceHash: inspection.proofRootHash,
        observedAt: updatedAt,
      })
      const nextStatus: NamespaceVerificationSessionRow["status"] = !inspection.rootExists
        ? "failed"
        : !inspection.rootKeyProofVerified
          ? "failed"
          : !inspection.anchorFreshEnough
            ? "failed"
            : "challenge_pending"
      const failureReason = !inspection.rootExists
        ? inspection.failureReason ?? "root_not_found"
        : !inspection.rootKeyProofVerified
          ? inspection.failureReason ?? "proof_not_verifiable"
          : !inspection.anchorFreshEnough
            ? inspection.failureReason ?? "anchor_set_stale"
            : null

      await client.execute({
        sql: `
          UPDATE namespace_verification_sessions
          SET status = ?2,
              challenge_host = NULL,
              challenge_txt_value = NULL,
              challenge_expires_at = ?3,
              challenge_kind = ?4,
              challenge_payload_json = ?5,
              root_exists = ?6,
              root_control_verified = NULL,
              expiry_horizon_sufficient = NULL,
              routing_enabled = NULL,
              pirate_dns_authority_verified = NULL,
              club_attach_allowed = NULL,
              pirate_web_routing_allowed = NULL,
              pirate_subdomain_issuance_allowed = NULL,
              control_class = ?7,
              operation_class = ?8,
              observation_provider = ?9,
              evidence_bundle_ref = ?10,
              failure_reason = ?11,
              accepted_at = NULL,
              anchor_height = ?12,
              anchor_block_hash = ?13,
              anchor_root_hash = ?14,
              proof_root_hash = ?15,
              updated_at = ?16
          WHERE namespace_verification_session_id = ?1
        `,
        args: [
          input.namespaceVerificationSessionId,
          nextStatus,
          challenge?.challengeExpiresAt ?? null,
          challenge?.challengeKind ?? null,
          challenge?.challengePayloadJson ?? null,
          toDbBool(inspection.rootExists),
          inspection.controlClass ?? row.control_class ?? "single_holder_root",
          inspection.operationClass ?? row.operation_class ?? "owner_managed_namespace",
          inspection.observationProvider,
          proofEvidenceBundleId,
          failureReason,
          inspection.acceptedAnchorHeight,
          inspection.acceptedAnchorBlockHash,
          inspection.acceptedAnchorRootHash,
          inspection.proofRootHash,
          updatedAt,
        ],
      })

      await upsertNamespaceAssertion(client, {
        namespaceVerificationSessionId: row.namespace_verification_session_id,
        namespaceVerificationId: row.namespace_verification_id,
        family: "spaces",
        assertionName: "root_exists",
        assertionValue: toDbBool(inspection.rootExists),
        sourceEvidenceBundleId: proofEvidenceBundleId,
        nowString: updatedAt,
      })
      await upsertNamespaceAssertion(client, {
        namespaceVerificationSessionId: row.namespace_verification_session_id,
        namespaceVerificationId: row.namespace_verification_id,
        family: "spaces",
        assertionName: "root_key_proof_verified",
        assertionValue: toDbBool(inspection.rootKeyProofVerified),
        sourceEvidenceBundleId: proofEvidenceBundleId,
        nowString: updatedAt,
      })
      await upsertNamespaceAssertion(client, {
        namespaceVerificationSessionId: row.namespace_verification_session_id,
        namespaceVerificationId: row.namespace_verification_id,
        family: "spaces",
        assertionName: "anchor_fresh_enough",
        assertionValue: toDbBool(inspection.anchorFreshEnough),
        sourceEvidenceBundleId: proofEvidenceBundleId,
        nowString: updatedAt,
      })

      return getNamespaceVerificationSession(client, input.namespaceVerificationSessionId, input.userId)
    }

    if (row.status !== "challenge_pending") {
      throw conflictError("Namespace verification session is not ready for signature verification")
    }
    if (row.challenge_kind !== "schnorr_sign" || !row.challenge_payload_json) {
      throw conflictError("Namespace verification challenge is not currently issued")
    }
    if (row.challenge_expires_at && Date.parse(row.challenge_expires_at) <= now.getTime()) {
      await client.execute({
        sql: `
          UPDATE namespace_verification_sessions
          SET status = 'failed',
              failure_reason = 'session_expired',
              updated_at = ?2
          WHERE namespace_verification_session_id = ?1
        `,
        args: [input.namespaceVerificationSessionId, updatedAt],
      })
      return getNamespaceVerificationSession(client, input.namespaceVerificationSessionId, input.userId)
    }

    const signature = typeof input.signaturePayload?.signature === "string"
      ? input.signaturePayload.signature.trim()
      : ""
    if (!signature) {
      await client.execute({
        sql: `
          UPDATE namespace_verification_sessions
          SET status = 'failed',
              failure_reason = 'challenge_not_signed',
              updated_at = ?2
          WHERE namespace_verification_session_id = ?1
        `,
        args: [input.namespaceVerificationSessionId, updatedAt],
      })
      return getNamespaceVerificationSession(client, input.namespaceVerificationSessionId, input.userId)
    }

    const inspection = await inspectSpacesNamespace({
      env,
      normalizedRootLabel,
    })
    const digest = input.signaturePayload?.digest?.trim() || readChallengeDigest(row)
    if (!digest || !inspection.rootPubkey) {
      throw internalError("Spaces verification challenge is incomplete")
    }

    const signatureCheck = await verifySpacesNamespaceSignature({
      env,
      normalizedRootLabel,
      digest,
      signature,
      rootPubkey: inspection.rootPubkey,
      signerPubkey: input.signaturePayload?.signer_pubkey ?? null,
      algorithm: input.signaturePayload?.algorithm ?? null,
    })
    const liveSignatureVerified = signatureCheck.validSignature && !signatureCheck.wrongSigner
    const rootExists = toDbBool(inspection.rootExists)
    const rootKeyProofVerified = toDbBool(inspection.rootKeyProofVerified)
    const anchorFreshEnough = toDbBool(inspection.anchorFreshEnough)

    const signatureEvidenceBundleId = await insertNamespaceEvidenceBundle(client, {
      namespaceVerificationSessionId: row.namespace_verification_session_id,
      namespaceVerificationId: row.namespace_verification_id,
      family: "spaces",
      normalizedRootLabel,
      evidenceKind: "challenge_signature",
      provider: signatureCheck.observationProvider,
      rawResponseJson: JSON.stringify({
        digest,
        message: readChallengeMessage(row),
        signature,
        algorithm: input.signaturePayload?.algorithm ?? "bip340_schnorr",
        signer_pubkey: input.signaturePayload?.signer_pubkey ?? null,
        verification_failure_reason: signatureCheck.failureReason,
      }),
      evidenceHash: createHash("sha256").update(signature).digest("hex"),
      observedAt: updatedAt,
    })
    const acceptedSnapshotBundleId = await insertNamespaceEvidenceBundle(client, {
      namespaceVerificationSessionId: row.namespace_verification_session_id,
      namespaceVerificationId: row.namespace_verification_id,
      family: "spaces",
      normalizedRootLabel,
      evidenceKind: "accepted_snapshot",
      provider: inspection.observationProvider,
      rawResponseJson: JSON.stringify({
        root_exists: inspection.rootExists,
        root_key_proof_verified: inspection.rootKeyProofVerified,
        anchor_fresh_enough: inspection.anchorFreshEnough,
        live_signature_verified: liveSignatureVerified,
        root_pubkey: inspection.rootPubkey,
        accepted_anchor_height: inspection.acceptedAnchorHeight,
        accepted_anchor_block_hash: inspection.acceptedAnchorBlockHash,
        accepted_anchor_root_hash: inspection.acceptedAnchorRootHash,
        proof_root_hash: inspection.proofRootHash,
        challenge_digest: digest,
      }),
      evidenceHash: inspection.proofRootHash,
      observedAt: updatedAt,
    })

    await upsertNamespaceAssertion(client, {
      namespaceVerificationSessionId: row.namespace_verification_session_id,
      namespaceVerificationId: row.namespace_verification_id,
      family: "spaces",
      assertionName: "root_exists",
      assertionValue: rootExists,
      sourceEvidenceBundleId: acceptedSnapshotBundleId,
      nowString: updatedAt,
    })
    await upsertNamespaceAssertion(client, {
      namespaceVerificationSessionId: row.namespace_verification_session_id,
      namespaceVerificationId: row.namespace_verification_id,
      family: "spaces",
      assertionName: "root_key_proof_verified",
      assertionValue: rootKeyProofVerified,
      sourceEvidenceBundleId: acceptedSnapshotBundleId,
      nowString: updatedAt,
    })
    await upsertNamespaceAssertion(client, {
      namespaceVerificationSessionId: row.namespace_verification_session_id,
      namespaceVerificationId: row.namespace_verification_id,
      family: "spaces",
      assertionName: "anchor_fresh_enough",
      assertionValue: anchorFreshEnough,
      sourceEvidenceBundleId: acceptedSnapshotBundleId,
      nowString: updatedAt,
    })
    await upsertNamespaceAssertion(client, {
      namespaceVerificationSessionId: row.namespace_verification_session_id,
      namespaceVerificationId: row.namespace_verification_id,
      family: "spaces",
      assertionName: "live_signature_verified",
      assertionValue: toDbBool(liveSignatureVerified),
      sourceEvidenceBundleId: signatureEvidenceBundleId,
      nowString: updatedAt,
    })

    const clubAttachAllowed = inspection.rootExists
      && inspection.rootKeyProofVerified
      && liveSignatureVerified
      && creatorUniqueHumanVerified

    await upsertNamespaceCapability(client, {
      namespaceVerificationSessionId: row.namespace_verification_session_id,
      namespaceVerificationId: row.namespace_verification_id,
      family: "spaces",
      capabilityName: "club_attach_allowed",
      capabilityValue: toDbBool(clubAttachAllowed),
      sourceEvidenceBundleId: acceptedSnapshotBundleId,
      nowString: updatedAt,
    })
    await upsertNamespaceCapability(client, {
      namespaceVerificationSessionId: row.namespace_verification_session_id,
      namespaceVerificationId: row.namespace_verification_id,
      family: "spaces",
      capabilityName: "owner_signed_record_updates_allowed",
      capabilityValue: 0,
      sourceEvidenceBundleId: acceptedSnapshotBundleId,
      nowString: updatedAt,
    })
    await upsertNamespaceCapability(client, {
      namespaceVerificationSessionId: row.namespace_verification_session_id,
      namespaceVerificationId: row.namespace_verification_id,
      family: "spaces",
      capabilityName: "pirate_subspace_issuance_allowed",
      capabilityValue: 0,
      sourceEvidenceBundleId: acceptedSnapshotBundleId,
      nowString: updatedAt,
    })

    const failureReason = !inspection.rootExists
      ? inspection.failureReason ?? "root_not_found"
      : !inspection.rootKeyProofVerified
        ? inspection.failureReason ?? "proof_not_verifiable"
      : !inspection.anchorFreshEnough
          ? inspection.failureReason ?? "anchor_set_stale"
          : !liveSignatureVerified
            ? signatureCheck.wrongSigner
              ? "wrong_signer"
              : signatureCheck.failureReason ?? "invalid_signature"
            : !creatorUniqueHumanVerified
              ? "creator_not_unique_human_verified"
              : null

    if (failureReason) {
      await client.execute({
        sql: `
          UPDATE namespace_verification_sessions
          SET status = 'failed',
              root_exists = ?2,
              root_control_verified = NULL,
              expiry_horizon_sufficient = NULL,
              routing_enabled = NULL,
              pirate_dns_authority_verified = NULL,
              club_attach_allowed = 0,
              pirate_web_routing_allowed = NULL,
              pirate_subdomain_issuance_allowed = NULL,
              control_class = ?3,
              operation_class = ?4,
              observation_provider = ?5,
              evidence_bundle_ref = ?6,
              failure_reason = ?7,
              accepted_at = NULL,
              anchor_height = ?8,
              anchor_block_hash = ?9,
              anchor_root_hash = ?10,
              proof_root_hash = ?11,
              updated_at = ?12
          WHERE namespace_verification_session_id = ?1
        `,
        args: [
          input.namespaceVerificationSessionId,
          rootExists,
          inspection.controlClass ?? row.control_class ?? "single_holder_root",
          inspection.operationClass ?? row.operation_class ?? "owner_managed_namespace",
          inspection.observationProvider,
          acceptedSnapshotBundleId,
          failureReason,
          inspection.acceptedAnchorHeight,
          inspection.acceptedAnchorBlockHash,
          inspection.acceptedAnchorRootHash,
          inspection.proofRootHash,
          updatedAt,
        ],
      })
      return getNamespaceVerificationSession(client, input.namespaceVerificationSessionId, input.userId)
    }

    const namespaceVerificationId = row.namespace_verification_id ?? makeId("nv")
    await insertOrReplaceNamespaceVerification(client, {
      namespaceVerificationId,
      namespaceVerificationSessionId: row.namespace_verification_session_id,
      userId: row.user_id,
      family: "spaces",
      normalizedRootLabel,
      rootExists: 1,
      rootControlVerified: null,
      expiryHorizonSufficient: null,
      routingEnabled: null,
      pirateDnsAuthorityVerified: null,
      clubAttachAllowed: 1,
      pirateWebRoutingAllowed: null,
      pirateSubdomainIssuanceAllowed: null,
      controlClass: inspection.controlClass ?? row.control_class ?? "single_holder_root",
      operationClass: inspection.operationClass ?? row.operation_class ?? "owner_managed_namespace",
      observationProvider: inspection.observationProvider,
      evidenceBundleRef: acceptedSnapshotBundleId,
      acceptedAt: updatedAt,
      expiresAt: row.expires_at || addHours(now, 24),
      anchorHeight: inspection.acceptedAnchorHeight,
      anchorBlockHash: inspection.acceptedAnchorBlockHash,
      anchorRootHash: inspection.acceptedAnchorRootHash,
      proofRootHash: inspection.proofRootHash,
    })

    for (const [assertionName, assertionValue, sourceEvidenceBundleId] of [
      ["root_exists", 1, acceptedSnapshotBundleId],
      ["root_key_proof_verified", 1, acceptedSnapshotBundleId],
      ["anchor_fresh_enough", anchorFreshEnough, acceptedSnapshotBundleId],
      ["live_signature_verified", 1, signatureEvidenceBundleId],
    ] as const) {
      await upsertNamespaceAssertion(client, {
        namespaceVerificationSessionId: row.namespace_verification_session_id,
        namespaceVerificationId,
        family: "spaces",
        assertionName,
        assertionValue,
        sourceEvidenceBundleId,
        nowString: updatedAt,
      })
    }

    for (const [capabilityName, capabilityValue] of [
      ["club_attach_allowed", 1],
      ["owner_signed_record_updates_allowed", 0],
      ["pirate_subspace_issuance_allowed", 0],
    ] as const) {
      await upsertNamespaceCapability(client, {
        namespaceVerificationSessionId: row.namespace_verification_session_id,
        namespaceVerificationId,
        family: "spaces",
        capabilityName,
        capabilityValue,
        sourceEvidenceBundleId: acceptedSnapshotBundleId,
        nowString: updatedAt,
      })
    }

    await client.execute({
      sql: `
        UPDATE namespace_verification_sessions
        SET namespace_verification_id = ?2,
            status = 'verified',
            root_exists = 1,
            root_control_verified = NULL,
            expiry_horizon_sufficient = NULL,
            routing_enabled = NULL,
            pirate_dns_authority_verified = NULL,
            club_attach_allowed = 1,
            pirate_web_routing_allowed = NULL,
            pirate_subdomain_issuance_allowed = NULL,
            control_class = ?3,
            operation_class = ?4,
            observation_provider = ?5,
            evidence_bundle_ref = ?6,
            failure_reason = NULL,
            accepted_at = ?7,
            anchor_height = ?8,
            anchor_block_hash = ?9,
            anchor_root_hash = ?10,
            proof_root_hash = ?11,
            updated_at = ?7
        WHERE namespace_verification_session_id = ?1
      `,
      args: [
        input.namespaceVerificationSessionId,
        namespaceVerificationId,
        inspection.controlClass ?? row.control_class ?? "single_holder_root",
        inspection.operationClass ?? row.operation_class ?? "owner_managed_namespace",
        inspection.observationProvider,
        acceptedSnapshotBundleId,
        updatedAt,
        inspection.acceptedAnchorHeight,
        inspection.acceptedAnchorBlockHash,
        inspection.acceptedAnchorRootHash,
        inspection.proofRootHash,
      ],
    })

    return getNamespaceVerificationSession(client, input.namespaceVerificationSessionId, input.userId)
  }

  if (input.restartChallenge) {
    const challengeExpiresAt = new Date(now.getTime() + HNS_CHALLENGE_TTL_MS).toISOString()
    await client.execute({
      sql: `
        UPDATE namespace_verification_sessions
        SET status = 'challenge_required',
            challenge_txt_value = ?2,
            challenge_expires_at = ?3,
            updated_at = ?4
        WHERE namespace_verification_session_id = ?1
      `,
      args: [input.namespaceVerificationSessionId, `pirate-verification=${makeId("nch")}`, challengeExpiresAt, updatedAt],
    })
    return getNamespaceVerificationSession(client, input.namespaceVerificationSessionId, input.userId)
  }

  if (row.challenge_expires_at && Date.parse(row.challenge_expires_at) <= now.getTime()) {
    await client.execute({
      sql: `
        UPDATE namespace_verification_sessions
        SET status = 'expired',
            failure_reason = 'challenge_expired',
            updated_at = ?2
        WHERE namespace_verification_session_id = ?1
      `,
      args: [input.namespaceVerificationSessionId, updatedAt],
    })
    return getNamespaceVerificationSession(client, input.namespaceVerificationSessionId, input.userId)
  }

  if (String(env.HNS_VERIFICATION_PROVIDER || "local_stub").trim() !== "local_stub") {
    const observation = await verifyHnsTxtChallenge(env, {
      normalizedRootLabel: row.normalized_root_label ?? row.submitted_root_label.toLowerCase(),
      challengeHost: row.challenge_host ?? `_pirate.${row.submitted_root_label.toLowerCase()}`,
      challengeTxtValue: row.challenge_txt_value ?? "",
    })
    const evidenceBundleId = makeId("nev")
    const normalizedRootLabel = row.normalized_root_label ?? row.submitted_root_label.toLowerCase()

    if (observation.kind === "challenge_pending") {
      await client.batch([
        {
          sql: `
            UPDATE namespace_verification_sessions
            SET status = 'challenge_pending',
                root_exists = ?2,
                root_control_verified = 0,
                expiry_horizon_sufficient = NULL,
                routing_enabled = NULL,
                pirate_dns_authority_verified = NULL,
                club_attach_allowed = NULL,
                pirate_web_routing_allowed = NULL,
                pirate_subdomain_issuance_allowed = NULL,
                control_class = NULL,
                operation_class = NULL,
                observation_provider = ?3,
                evidence_bundle_ref = ?4,
                failure_reason = ?5,
                accepted_at = NULL,
                updated_at = ?6
            WHERE namespace_verification_session_id = ?1
          `,
          args: [
            input.namespaceVerificationSessionId,
            observation.rootExists ? 1 : 0,
            observation.observationProvider,
            evidenceBundleId,
            observation.failureReason,
            updatedAt,
          ],
        },
        {
          sql: `
            INSERT INTO namespace_verification_evidence_bundles (
              evidence_bundle_id, namespace_verification_session_id, namespace_verification_id, family, normalized_root_label,
              evidence_kind, provider, resolver_path_json, raw_response_json, evidence_hash, observed_at, created_at, updated_at
            ) VALUES (?1, ?2, ?3, 'hns', ?4, 'txt_observation', ?5, ?6, ?7, ?8, ?9, ?9, ?9)
          `,
          args: [
            evidenceBundleId,
            input.namespaceVerificationSessionId,
            row.namespace_verification_id,
            normalizedRootLabel,
            observation.observationProvider,
            JSON.stringify(observation.resolverPath),
            JSON.stringify(observation.rawResponse),
            observation.evidenceHash,
            updatedAt,
          ],
        },
      ], "write")

      return getNamespaceVerificationSession(client, input.namespaceVerificationSessionId, input.userId)
    }

    if (observation.kind === "failed") {
      await client.batch([
        {
          sql: `
            UPDATE namespace_verification_sessions
            SET status = 'failed',
                root_exists = ?2,
                root_control_verified = 0,
                expiry_horizon_sufficient = NULL,
                routing_enabled = NULL,
                pirate_dns_authority_verified = NULL,
                club_attach_allowed = NULL,
                pirate_web_routing_allowed = NULL,
                pirate_subdomain_issuance_allowed = NULL,
                control_class = NULL,
                operation_class = NULL,
                observation_provider = ?3,
                evidence_bundle_ref = ?4,
                failure_reason = ?5,
                accepted_at = NULL,
                updated_at = ?6
            WHERE namespace_verification_session_id = ?1
          `,
          args: [
            input.namespaceVerificationSessionId,
            observation.rootExists ? 1 : 0,
            observation.observationProvider,
            evidenceBundleId,
            observation.failureReason,
            updatedAt,
          ],
        },
        {
          sql: `
            INSERT INTO namespace_verification_evidence_bundles (
              evidence_bundle_id, namespace_verification_session_id, namespace_verification_id, family, normalized_root_label,
              evidence_kind, provider, resolver_path_json, raw_response_json, evidence_hash, observed_at, created_at, updated_at
            ) VALUES (?1, ?2, ?3, 'hns', ?4, 'txt_observation', ?5, ?6, ?7, ?8, ?9, ?9, ?9)
          `,
          args: [
            evidenceBundleId,
            input.namespaceVerificationSessionId,
            row.namespace_verification_id,
            normalizedRootLabel,
            observation.observationProvider,
            JSON.stringify(observation.resolverPath),
            JSON.stringify(observation.rawResponse),
            observation.evidenceHash,
            updatedAt,
          ],
        },
      ], "write")

      return getNamespaceVerificationSession(client, input.namespaceVerificationSessionId, input.userId)
    }

    const verificationId = row.namespace_verification_id ?? makeId("nv")
    const clubAttachAllowed = observation.rootControlVerified && observation.expiryHorizonSufficient
    const pirateWebRoutingAllowed = observation.rootControlVerified && observation.routingEnabled
    const pirateSubdomainIssuanceAllowed =
      observation.rootControlVerified
      && observation.expiryHorizonSufficient
      && observation.pirateDnsAuthorityVerified

    await client.batch([
      {
        sql: `
          UPDATE namespace_verification_sessions
          SET namespace_verification_id = ?2,
              status = 'verified',
              root_exists = 1,
              root_control_verified = 1,
              expiry_horizon_sufficient = ?3,
              routing_enabled = ?4,
              pirate_dns_authority_verified = ?5,
              club_attach_allowed = ?6,
              pirate_web_routing_allowed = ?7,
              pirate_subdomain_issuance_allowed = ?8,
              control_class = ?9,
              operation_class = ?10,
              observation_provider = ?11,
              evidence_bundle_ref = ?12,
              failure_reason = NULL,
              accepted_at = ?13,
              updated_at = ?13
          WHERE namespace_verification_session_id = ?1
        `,
        args: [
          input.namespaceVerificationSessionId,
          verificationId,
          observation.expiryHorizonSufficient ? 1 : 0,
          observation.routingEnabled ? 1 : 0,
          observation.pirateDnsAuthorityVerified ? 1 : 0,
          clubAttachAllowed ? 1 : 0,
          pirateWebRoutingAllowed ? 1 : 0,
          pirateSubdomainIssuanceAllowed ? 1 : 0,
          observation.controlClass,
          observation.operationClass,
          observation.observationProvider,
          evidenceBundleId,
          updatedAt,
        ],
      },
      {
        sql: `
          INSERT INTO namespace_verifications (
            namespace_verification_id, source_namespace_verification_session_id, user_id, family, normalized_root_label,
            status, root_exists, root_control_verified, expiry_horizon_sufficient, routing_enabled,
            pirate_dns_authority_verified, club_attach_allowed, pirate_web_routing_allowed, pirate_subdomain_issuance_allowed,
            control_class, operation_class, observation_provider, evidence_bundle_ref, accepted_at, expires_at, created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, 'hns', ?4, 'verified', 1, 1, ?5, ?6, ?7, ?8, ?9, ?10,
            ?11, ?12, ?13, ?14, ?15, ?16, ?15, ?15
          )
          ON CONFLICT (namespace_verification_id) DO UPDATE SET
            source_namespace_verification_session_id = excluded.source_namespace_verification_session_id,
            user_id = excluded.user_id,
            family = excluded.family,
            normalized_root_label = excluded.normalized_root_label,
            status = excluded.status,
            root_exists = excluded.root_exists,
            root_control_verified = excluded.root_control_verified,
            expiry_horizon_sufficient = excluded.expiry_horizon_sufficient,
            routing_enabled = excluded.routing_enabled,
            pirate_dns_authority_verified = excluded.pirate_dns_authority_verified,
            club_attach_allowed = excluded.club_attach_allowed,
            pirate_web_routing_allowed = excluded.pirate_web_routing_allowed,
            pirate_subdomain_issuance_allowed = excluded.pirate_subdomain_issuance_allowed,
            control_class = excluded.control_class,
            operation_class = excluded.operation_class,
            observation_provider = excluded.observation_provider,
            evidence_bundle_ref = excluded.evidence_bundle_ref,
            accepted_at = excluded.accepted_at,
            expires_at = excluded.expires_at,
            updated_at = excluded.updated_at
        `,
        args: [
          verificationId,
          input.namespaceVerificationSessionId,
          input.userId,
          normalizedRootLabel,
          observation.expiryHorizonSufficient ? 1 : 0,
          observation.routingEnabled ? 1 : 0,
          observation.pirateDnsAuthorityVerified ? 1 : 0,
          clubAttachAllowed ? 1 : 0,
          pirateWebRoutingAllowed ? 1 : 0,
          pirateSubdomainIssuanceAllowed ? 1 : 0,
          observation.controlClass,
          observation.operationClass,
          observation.observationProvider,
          evidenceBundleId,
          updatedAt,
          row.expires_at,
        ],
      },
      {
        sql: `
          INSERT INTO namespace_verification_evidence_bundles (
            evidence_bundle_id, namespace_verification_session_id, namespace_verification_id, family, normalized_root_label,
            evidence_kind, provider, resolver_path_json, raw_response_json, evidence_hash, observed_at, created_at, updated_at
          ) VALUES (?1, ?2, ?3, 'hns', ?4, 'txt_observation', ?5, ?6, ?7, ?8, ?9, ?9, ?9)
        `,
        args: [
          evidenceBundleId,
          input.namespaceVerificationSessionId,
          verificationId,
          normalizedRootLabel,
          observation.observationProvider,
          JSON.stringify(observation.resolverPath),
          JSON.stringify(observation.rawResponse),
          observation.evidenceHash,
          updatedAt,
        ],
      },
    ], "write")

    return getNamespaceVerificationSession(client, input.namespaceVerificationSessionId, input.userId)
  }

  const verificationId = row.namespace_verification_id ?? makeId("nv")
  const evidenceBundleId = makeId("nev")
  const expiresAt = row.expires_at

  await client.batch([
    {
      sql: `
        UPDATE namespace_verification_sessions
        SET namespace_verification_id = ?2,
            status = 'verified',
            root_exists = 1,
            root_control_verified = 1,
            expiry_horizon_sufficient = 1,
            routing_enabled = 1,
            pirate_dns_authority_verified = 0,
            club_attach_allowed = 1,
            pirate_web_routing_allowed = 1,
            pirate_subdomain_issuance_allowed = 0,
            control_class = 'single_holder_root',
            operation_class = 'owner_managed_namespace',
            observation_provider = 'local_stub',
            evidence_bundle_ref = ?3,
            failure_reason = NULL,
            accepted_at = ?4,
            updated_at = ?4
        WHERE namespace_verification_session_id = ?1
      `,
      args: [input.namespaceVerificationSessionId, verificationId, evidenceBundleId, updatedAt],
    },
    {
      sql: `
        INSERT INTO namespace_verifications (
          namespace_verification_id, source_namespace_verification_session_id, user_id, family, normalized_root_label,
          status, root_exists, root_control_verified, expiry_horizon_sufficient, routing_enabled,
          pirate_dns_authority_verified, club_attach_allowed, pirate_web_routing_allowed, pirate_subdomain_issuance_allowed,
          control_class, operation_class, observation_provider, evidence_bundle_ref, accepted_at, expires_at, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, 'hns', ?4, 'verified', 1, 1, 1, 1, 0, 1, 1, 0,
          'single_holder_root', 'owner_managed_namespace', 'local_stub', ?5, ?6, ?7, ?6, ?6
        )
        ON CONFLICT (namespace_verification_id) DO UPDATE SET
          source_namespace_verification_session_id = excluded.source_namespace_verification_session_id,
          user_id = excluded.user_id,
          family = excluded.family,
          normalized_root_label = excluded.normalized_root_label,
          status = excluded.status,
          root_exists = excluded.root_exists,
          root_control_verified = excluded.root_control_verified,
          expiry_horizon_sufficient = excluded.expiry_horizon_sufficient,
          routing_enabled = excluded.routing_enabled,
          pirate_dns_authority_verified = excluded.pirate_dns_authority_verified,
          club_attach_allowed = excluded.club_attach_allowed,
          pirate_web_routing_allowed = excluded.pirate_web_routing_allowed,
          pirate_subdomain_issuance_allowed = excluded.pirate_subdomain_issuance_allowed,
          control_class = excluded.control_class,
          operation_class = excluded.operation_class,
          observation_provider = excluded.observation_provider,
          evidence_bundle_ref = excluded.evidence_bundle_ref,
          accepted_at = excluded.accepted_at,
          expires_at = excluded.expires_at,
          updated_at = excluded.updated_at
      `,
      args: [verificationId, input.namespaceVerificationSessionId, input.userId, row.normalized_root_label ?? row.submitted_root_label.toLowerCase(), evidenceBundleId, updatedAt, expiresAt],
    },
    {
      sql: `
        INSERT INTO namespace_verification_evidence_bundles (
          evidence_bundle_id, namespace_verification_session_id, namespace_verification_id, family, normalized_root_label,
          evidence_kind, provider, resolver_path_json, raw_response_json, evidence_hash, observed_at, created_at, updated_at
        ) VALUES (?1, ?2, ?3, 'hns', ?4, 'accepted_snapshot', 'local_stub', ?5, ?6, NULL, ?7, ?7, ?7)
      `,
      args: [
        evidenceBundleId,
        input.namespaceVerificationSessionId,
        verificationId,
        row.normalized_root_label ?? row.submitted_root_label.toLowerCase(),
        JSON.stringify(["local_stub"]),
        JSON.stringify({ root_exists: true, root_control_verified: true, routing_enabled: true }),
        updatedAt,
      ],
    },
  ], "write")

  return getNamespaceVerificationSession(client, input.namespaceVerificationSessionId, input.userId)
}

export async function getNamespaceVerification(
  client: Client,
  namespaceVerificationId: string,
  userId: string,
): Promise<NamespaceVerification | null> {
  const row = await getNamespaceVerificationRowForUser(client, namespaceVerificationId, userId)
  return row ? serializeNamespaceVerification(row) : null
}

export interface VerificationRepository {
  startVerificationSession(input: {
    userId: string
    provider: "self" | "very"
    walletAttachmentId?: string | null
    requestedCapabilities?: Array<"unique_human" | "age_over_18" | "nationality" | "gender"> | null
    verificationIntent?: StartVerificationSessionRequest["verification_intent"]
    policyId?: string | null
  }): Promise<VerificationSession>
  getVerificationSession(verificationSessionId: string, userId: string): Promise<VerificationSession | null>
  completeVerificationSession(input: {
    verificationSessionId: string
    userId: string
    attestationId?: string | null
    proofHash?: string | null
    proof?: string | null
  }): Promise<VerificationSession | null>
  completeVerificationSessionByCallback(input: {
    verificationSessionId: string
    requestBody: unknown
  }): Promise<VerificationSession | null>
  startNamespaceVerificationSession(input: {
    userId: string
    family: "hns" | "spaces"
    rootLabel: string
  }): Promise<NamespaceVerificationSession>
  getNamespaceVerificationSession(
    namespaceVerificationSessionId: string,
    userId: string,
  ): Promise<NamespaceVerificationSession | null>
  completeNamespaceVerificationSession(input: {
    namespaceVerificationSessionId: string
    userId: string
    restartChallenge?: boolean | null
    signaturePayload?: {
      signature?: string | null
      algorithm?: string | null
      signer_pubkey?: string | null
      digest?: string | null
    } | null
  }): Promise<NamespaceVerificationSession | null>
  getNamespaceVerification(namespaceVerificationId: string, userId: string): Promise<NamespaceVerification | null>
}

export class ControlPlaneVerificationRepository implements VerificationRepository {
  constructor(private readonly client: ControlPlaneDbClient, private readonly env: Env) {}

  async startVerificationSession(input: {
    userId: string
    provider: "self" | "very"
    walletAttachmentId?: string | null
    requestedCapabilities?: Array<"unique_human" | "age_over_18" | "nationality" | "gender"> | null
    verificationIntent?: StartVerificationSessionRequest["verification_intent"]
    policyId?: string | null
  }): Promise<VerificationSession> {
    return startVerificationSession(this.client, {
      ...input,
      env: this.env,
    })
  }

  async getVerificationSession(verificationSessionId: string, userId: string): Promise<VerificationSession | null> {
    return getVerificationSession(this.client, verificationSessionId, userId, this.env)
  }

  async completeVerificationSession(input: {
    verificationSessionId: string
    userId: string
    attestationId?: string | null
    proofHash?: string | null
    proof?: string | null
  }): Promise<VerificationSession | null> {
    return completeVerificationSession(this.client, {
      ...input,
      env: this.env,
    })
  }

  async completeVerificationSessionByCallback(input: {
    verificationSessionId: string
    requestBody: unknown
  }): Promise<VerificationSession | null> {
    return completeVerificationSessionByCallback(this.client, {
      ...input,
      env: this.env,
    })
  }

  async startNamespaceVerificationSession(input: {
    userId: string
    family: "hns" | "spaces"
    rootLabel: string
  }): Promise<NamespaceVerificationSession> {
    return startNamespaceVerificationSession(this.client, {
      ...input,
      env: this.env,
    })
  }

  async getNamespaceVerificationSession(
    namespaceVerificationSessionId: string,
    userId: string,
  ): Promise<NamespaceVerificationSession | null> {
    return getNamespaceVerificationSession(this.client, namespaceVerificationSessionId, userId)
  }

  async completeNamespaceVerificationSession(input: {
    namespaceVerificationSessionId: string
    userId: string
    restartChallenge?: boolean | null
    signaturePayload?: {
      signature?: string | null
      algorithm?: string | null
      signer_pubkey?: string | null
      digest?: string | null
    } | null
  }): Promise<NamespaceVerificationSession | null> {
    return completeNamespaceVerificationSession(this.client, this.env, input)
  }

  async getNamespaceVerification(namespaceVerificationId: string, userId: string): Promise<NamespaceVerification | null> {
    return getNamespaceVerification(this.client, namespaceVerificationId, userId)
  }
}

const globalScope = globalThis as typeof globalThis & {
  __pirateControlPlaneVerificationRepository?: ControlPlaneVerificationRepository
  __pirateControlPlaneVerificationRepositoryKey?: string
}

function canCacheControlPlaneVerificationRepository(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
}

export function getControlPlaneVerificationRepository(env: Env): ControlPlaneVerificationRepository {
  const cacheKey = requireControlPlaneDbUrl(env)

  if (
    canCacheControlPlaneVerificationRepository()
    && (
    globalScope.__pirateControlPlaneVerificationRepository
    && globalScope.__pirateControlPlaneVerificationRepositoryKey === cacheKey
    )
  ) {
    return globalScope.__pirateControlPlaneVerificationRepository
  }

  const repository = new ControlPlaneVerificationRepository(
    createControlPlaneDbClient(env),
    env,
  )
  if (canCacheControlPlaneVerificationRepository()) {
    globalScope.__pirateControlPlaneVerificationRepository = repository
    globalScope.__pirateControlPlaneVerificationRepositoryKey = cacheKey
  }
  return repository
}

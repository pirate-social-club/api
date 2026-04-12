import { createHash } from "node:crypto"
import { Resolver, resolve4, resolve6 } from "node:dns/promises"
import { envFlag } from "../helpers"
import type { Env } from "../../types"

export type HnsVerificationSuccess = {
  kind: "verified"
  rootExists: boolean
  // v0 approximation: DNS TXT proof demonstrates control of the served zone,
  // not onchain ownership of the HNS root itself.
  rootControlVerified: boolean
  // v0 approximation: deployment policy flag, not chain-derived expiry evidence.
  expiryHorizonSufficient: boolean
  routingEnabled: boolean
  pirateDnsAuthorityVerified: boolean
  // v0 approximation until chain-aware ownership classification exists.
  controlClass: "single_holder_root"
  operationClass: "owner_managed_namespace" | "pirate_delegated_namespace"
  observationProvider: string
  resolverPath: string[]
  rawResponse: Record<string, unknown>
  evidenceHash: string
}

export type HnsVerificationPending = {
  kind: "challenge_pending"
  failureReason: "challenge_not_visible"
  rootExists: boolean
  observationProvider: string
  resolverPath: string[]
  rawResponse: Record<string, unknown>
  evidenceHash: string
}

export type HnsVerificationFailure = {
  kind: "failed"
  failureReason:
    | "root_not_found"
    | "wrong_txt_value"
    | "resolver_unavailable"
    | "resolver_error"
  rootExists: boolean
  observationProvider: string
  resolverPath: string[]
  rawResponse: Record<string, unknown>
  evidenceHash: string
}

export type HnsVerificationObservation =
  | HnsVerificationSuccess
  | HnsVerificationPending
  | HnsVerificationFailure

type HnsQueryResolver = {
  resolveTxt(name: string): Promise<string[][]>
  resolveNs(name: string): Promise<string[]>
  resolve4(name: string): Promise<string[]>
  resolve6(name: string): Promise<string[]>
  resolveCname(name: string): Promise<string[]>
}

type HnsResolverFactory = {
  createResolver(host: string): Promise<HnsQueryResolver>
}

function parseTimeoutMs(value: string | undefined, fallbackMs: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\.+$/, "")
}

function parsePirateNsHosts(value: string | undefined): string[] {
  return String(value || "")
    .split(",")
    .map((item) => normalizeName(item))
    .filter(Boolean)
}

function isDnsNoDataError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && typeof (error as { code?: unknown }).code === "string"
    && ["ENODATA", "ENOTFOUND", "ENONAME", "NOTFOUND", "NXDOMAIN"].includes(String((error as { code?: string }).code))
}

async function resolveOptional<T>(query: () => Promise<T>, empty: T): Promise<T> {
  try {
    return await query()
  } catch (error) {
    if (isDnsNoDataError(error)) {
      return empty
    }
    throw error
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("resolver_timeout")), timeoutMs)
      }),
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

const defaultResolverFactory: HnsResolverFactory = {
  async createResolver(host: string): Promise<HnsQueryResolver> {
    const ipv4 = await resolve4(host).catch(() => [] as string[])
    const ipv6 = await resolve6(host).catch(() => [] as string[])
    const servers = [...ipv4, ...ipv6]
    if (servers.length === 0) {
      throw new Error("resolver_unavailable")
    }

    const resolver = new Resolver()
    resolver.setServers(servers)
    return resolver
  },
}

export async function verifyHnsTxtChallenge(
  env: Env,
  input: {
    normalizedRootLabel: string
    challengeHost: string
    challengeTxtValue: string
  },
  deps: HnsResolverFactory = defaultResolverFactory,
): Promise<HnsVerificationObservation> {
  const resolverHost = String(env.HNS_RESOLVER_HOST || "hnsdoh.com").trim() || "hnsdoh.com"
  const observationProvider = String(env.HNS_VERIFICATION_PROVIDER || "hnsdoh").trim() || "hnsdoh"
  const timeoutMs = parseTimeoutMs(env.HNS_VERIFICATION_TIMEOUT_MS, 10000)
  const pirateNsHosts = parsePirateNsHosts(env.HNS_PIRATE_NS_HOSTS)
  const expiryHorizonSufficient = envFlag(env.HNS_ASSUME_EXPIRY_HORIZON_SUFFICIENT, true)

  try {
    const resolver = await withTimeout(deps.createResolver(resolverHost), timeoutMs)
    const normalizedRootLabel = normalizeName(input.normalizedRootLabel)
    const challengeHost = normalizeName(input.challengeHost)

    const [rootNs, rootA, rootAaaa, rootCname, rootTxt, challengeTxt] = await withTimeout(
      Promise.all([
        resolveOptional(() => resolver.resolveNs(normalizedRootLabel), [] as string[]),
        resolveOptional(() => resolver.resolve4(normalizedRootLabel), [] as string[]),
        resolveOptional(() => resolver.resolve6(normalizedRootLabel), [] as string[]),
        resolveOptional(() => resolver.resolveCname(normalizedRootLabel), [] as string[]),
        resolveOptional(() => resolver.resolveTxt(normalizedRootLabel), [] as string[][]),
        resolveOptional(() => resolver.resolveTxt(challengeHost), [] as string[][]),
      ]),
      timeoutMs,
    )

    const flattenedRootTxt = rootTxt.map((entry) => entry.join("")).filter(Boolean)
    const flattenedChallengeTxt = challengeTxt.map((entry) => entry.join("")).filter(Boolean)
    const normalizedNs = rootNs.map((entry) => normalizeName(entry))
    const rootExists =
      normalizedNs.length > 0
      || rootA.length > 0
      || rootAaaa.length > 0
      || rootCname.length > 0
      || flattenedRootTxt.length > 0
    const routingEnabled = rootA.length > 0 || rootAaaa.length > 0 || rootCname.length > 0
    const pirateDnsAuthorityVerified =
      pirateNsHosts.length > 0 && normalizedNs.some((entry) => pirateNsHosts.includes(entry))
    const rawResponse = {
      resolver_host: resolverHost,
      root_label: normalizedRootLabel,
      challenge_host: challengeHost,
      verification_basis: "dns_txt_zone_control",
      ownership_scope: "zone_control_not_onchain_root_ownership",
      expiry_horizon_basis: expiryHorizonSufficient ? "assumed_true_from_env" : "assumed_false_from_env",
      control_class_basis: "assumed_single_holder_root_for_v0",
      root_ns: normalizedNs,
      root_a: rootA,
      root_aaaa: rootAaaa,
      root_cname: rootCname,
      root_txt: flattenedRootTxt,
      challenge_txt: flattenedChallengeTxt,
      expected_challenge_txt: input.challengeTxtValue,
    }
    const evidenceHash = createHash("sha256").update(JSON.stringify(rawResponse)).digest("hex")
    const resolverPath = [`udp://${resolverHost}:53`]

    if (!rootExists) {
      return {
        kind: "failed",
        failureReason: "root_not_found",
        rootExists: false,
        observationProvider,
        resolverPath,
        rawResponse,
        evidenceHash,
      }
    }

    if (flattenedChallengeTxt.length === 0) {
      return {
        kind: "challenge_pending",
        failureReason: "challenge_not_visible",
        rootExists: true,
        observationProvider,
        resolverPath,
        rawResponse,
        evidenceHash,
      }
    }

    if (!flattenedChallengeTxt.includes(input.challengeTxtValue)) {
      return {
        kind: "failed",
        failureReason: "wrong_txt_value",
        rootExists: true,
        observationProvider,
        resolverPath,
        rawResponse,
        evidenceHash,
      }
    }

    return {
      kind: "verified",
      rootExists: true,
      rootControlVerified: true,
      expiryHorizonSufficient,
      routingEnabled,
      pirateDnsAuthorityVerified,
      controlClass: "single_holder_root",
      operationClass: pirateDnsAuthorityVerified ? "pirate_delegated_namespace" : "owner_managed_namespace",
      observationProvider,
      resolverPath,
      rawResponse,
      evidenceHash,
    }
  } catch (error) {
    const rawResponse = {
      resolver_host: resolverHost,
      verification_basis: "dns_txt_zone_control",
      ownership_scope: "zone_control_not_onchain_root_ownership",
      message: error instanceof Error ? error.message : String(error),
    }
    return {
      kind: "failed",
      failureReason: error instanceof Error && error.message === "resolver_unavailable"
        ? "resolver_unavailable"
        : "resolver_error",
      rootExists: false,
      observationProvider,
      resolverPath: [`udp://${resolverHost}:53`],
      rawResponse,
      evidenceHash: createHash("sha256").update(JSON.stringify(rawResponse)).digest("hex"),
    }
  }
}

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { assertHnsRootLabel } from "../src/lib/verification/hns-verifier"

const port = Number(process.env.HNS_VERIFIER_PORT || "8798")
const nameservers = ["ns1.local.pirate.test", "ns2.local.pirate.test"]

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
}

function writeJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.statusCode = status
  res.setHeader("content-type", "application/json; charset=utf-8")
  res.end(JSON.stringify(body))
}

function normalizeRootLabel(value: unknown): string {
  const rootLabel = String(value || "").trim().toLowerCase()
  assertHnsRootLabel(rootLabel)
  return rootLabel
}

function challengeName(rootLabel: string): string {
  return `_pirate.${rootLabel}`
}

function localInspect(rootLabel: string): Record<string, unknown> {
  return {
    root_label: rootLabel,
    zone_name: rootLabel,
    challenge_name: challengeName(rootLabel),
    zone_exists: true,
    challenge_present: false,
    root_exists: true,
    root_control_verified: true,
    expiry_horizon_sufficient: true,
    routing_enabled: true,
    pirate_dns_authority_verified: true,
    control_class: "single_holder_root",
    operation_class: "pirate_delegated_namespace",
    nameservers,
    observation_provider: "web3dns_json_doh",
    failure_reason: null,
  }
}

// Mirrors the real verifier's child-zone state so the authority-health check
// has something to read back: a nonce must be PUBLISHED before it can be served.
const publishedChallenges = new Map<string, string>()

function localPublishTxt(body: Record<string, unknown>): Record<string, unknown> {
  const rootLabel = normalizeRootLabel(body.root_label)
  const value = String(body.challenge_txt_value || "")
  publishedChallenges.set(rootLabel, value)
  return {
    root_label: rootLabel,
    zone_name: rootLabel,
    challenge_name: challengeName(rootLabel),
    challenge_txt_value: value,
    zone_created: true,
    nameservers,
    observation_provider: "powerdns_api",
  }
}

function localAuthorityHealth(rootLabel: string): Record<string, unknown> {
  const published = publishedChallenges.has(rootLabel)
  return {
    root_label: rootLabel,
    zone_name: rootLabel,
    challenge_name: challengeName(rootLabel),
    zone_provisioned: published,
    challenge_present: published,
    challenge_served: published,
    nameservers,
    observation_provider: "powerdns_api",
  }
}

function localVerifyTxt(body: Record<string, unknown>): Record<string, unknown> {
  const rootLabel = normalizeRootLabel(body.root_label)
  return {
    verified: true,
    observation_provider: "web3dns_json_doh",
    ownership_source: "hns_parent_chain_txt",
    failure_reason: null,
    observed_values: typeof body.challenge_txt_value === "string" ? [body.challenge_txt_value] : [],
    root_exists: true,
    root_control_verified: true,
    expiry_horizon_sufficient: true,
    routing_enabled: true,
    pirate_dns_authority_verified: true,
    control_class: "single_holder_root",
    operation_class: "pirate_delegated_namespace",
    root_label: rootLabel,
    zone_name: rootLabel,
    challenge_name: typeof body.challenge_host === "string" && body.challenge_host.trim()
      ? body.challenge_host.trim()
      : challengeName(rootLabel),
  }
}

export function createLocalHnsVerifierServer(): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || `127.0.0.1:${port}`}`)
      if (req.method === "GET" && url.pathname === "/inspect-public") {
        writeJson(res, 200, localInspect(normalizeRootLabel(url.searchParams.get("root_label"))))
        return
      }

      if (req.method === "POST" && url.pathname === "/verify-txt-public") {
        writeJson(res, 200, localVerifyTxt(await readJson(req)))
        return
      }

      if (req.method === "POST" && (url.pathname === "/publish-txt" || url.pathname === "/ensure-zone")) {
        writeJson(res, 200, localPublishTxt(await readJson(req)))
        return
      }

      if (req.method === "GET" && url.pathname === "/authority-health") {
        writeJson(res, 200, localAuthorityHealth(normalizeRootLabel(url.searchParams.get("root_label"))))
        return
      }

      writeJson(res, 404, { error: "not_found" })
    } catch (error) {
      writeJson(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })
}

if (import.meta.main) {
  createLocalHnsVerifierServer().listen(port, "127.0.0.1", () => {
    console.log(`local HNS verifier listening on http://127.0.0.1:${port}`)
  })
}

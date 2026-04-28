import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { normalizeRootLabel } from "../src/lib/verification/spaces-verifier"

const port = Number(process.env.SPACES_VERIFIER_PORT || "8799")

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

function localInspect(rootLabel: string): Record<string, unknown> {
  const normalizedRootLabel = normalizeRootLabel(rootLabel)
  return {
    root_exists: true,
    root_key_proof_verified: true,
    root_pubkey: `local-spaces-root-pubkey:${normalizedRootLabel}`,
    control_class: "single_holder_root",
    operation_class: "owner_signed_updates_namespace",
    observation_provider: "local_spaces_verifier",
    accepted_anchor_height: 1,
    accepted_anchor_block_hash: "local-spaces-anchor",
    accepted_anchor_root_hash: `local-spaces-root:${normalizedRootLabel}`,
    proof_root_hash: `local-spaces-proof:${normalizedRootLabel}`,
    anchor_fresh_enough: true,
  }
}

function localVerifyPublish(body: Record<string, unknown>): Record<string, unknown> {
  const txtValue = typeof body.txt_value === "string" ? body.txt_value : ""
  const webUrl = typeof body.web_url === "string" ? body.web_url : null
  const freedomUrl = typeof body.freedom_url === "string" ? body.freedom_url : null
  return {
    fabric_publish_verified: true,
    root_key_proof_verified: true,
    web_target_verified: true,
    freedom_target_verified: true,
    observed_web_url: webUrl,
    observed_freedom_url: freedomUrl,
    observed_txt_values: txtValue ? [txtValue] : [],
    records: txtValue ? { "pirate-verify": [txtValue] } : {},
    accepted_anchor_height: 1,
    accepted_anchor_block_hash: "local-spaces-anchor",
    accepted_anchor_root_hash: "local-spaces-root",
    proof_root_hash: "local-spaces-proof",
    observation_provider: "local_spaces_verifier",
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || `127.0.0.1:${port}`}`)
    if (req.method === "GET" && url.pathname === "/inspect") {
      const rootLabel = url.searchParams.get("root_label") || ""
      writeJson(res, 200, localInspect(rootLabel))
      return
    }

    if (req.method === "POST" && url.pathname === "/verify-publish") {
      writeJson(res, 200, localVerifyPublish(await readJson(req)))
      return
    }

    writeJson(res, 404, { error: "not_found" })
  } catch (error) {
    writeJson(res, 400, {
      error: error instanceof Error ? error.message : String(error),
    })
  }
})

server.listen(port, "127.0.0.1", () => {
  console.log(`local Spaces verifier listening on http://127.0.0.1:${port}`)
})

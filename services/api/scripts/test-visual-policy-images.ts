import { readdirSync, readFileSync, statSync } from "node:fs"
import { basename, join } from "node:path"
import {
  classifyVisualFactsWithVlm,
  resolveVisualPolicyDecision,
} from "../src/lib/posts/visual-policy-analysis"
import { buildDefaultVisualPolicySettings } from "../src/lib/communities/community-policy-defaults"

const root = process.argv[2]
if (!root) {
  throw new Error("Usage: bun run scripts/test-visual-policy-images.ts <image-folder>")
}

function mimeTypeFor(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg"
  if (lower.endsWith(".png")) return "image/png"
  if (lower.endsWith(".webp")) return "image/webp"
  throw new Error(`Unsupported image type: ${path}`)
}

function collectImages(path: string): string[] {
  const entries = readdirSync(path)
  const images: string[] = []
  for (const entry of entries) {
    const full = join(path, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      images.push(...collectImages(full))
      continue
    }
    if (/\.(jpe?g|png|webp)$/i.test(entry)) {
      images.push(full)
    }
  }
  return images.sort()
}

const settings = buildDefaultVisualPolicySettings("visual_policy_test", new Date().toISOString())
const env = {
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL,
  OPENROUTER_VISUAL_POLICY_MODEL: process.env.OPENROUTER_VISUAL_POLICY_MODEL,
  OPENROUTER_VISUAL_POLICY_TIMEOUT_MS: process.env.OPENROUTER_VISUAL_POLICY_TIMEOUT_MS,
  OPENROUTER_TIMEOUT_MS: process.env.OPENROUTER_TIMEOUT_MS,
}

const images = collectImages(root)
if (!images.length) {
  throw new Error(`No images found under ${root}`)
}

for (const imagePath of images) {
  const dataUrl = `data:${mimeTypeFor(imagePath)};base64,${readFileSync(imagePath).toString("base64")}`
  const classified = await classifyVisualFactsWithVlm({
    env,
    imageUrl: dataUrl,
  })

  if (!classified) {
    console.log(JSON.stringify({
      image: `${basename(join(imagePath, ".."))}/${basename(imagePath)}`,
      error: "classification_failed",
    }))
    continue
  }

  const decision = resolveVisualPolicyDecision(settings, classified.facts)
  console.log(JSON.stringify({
    image: `${basename(join(imagePath, ".."))}/${basename(imagePath)}`,
    model: classified.model,
    policyDecision: decision.policyDecision,
    reasonCodes: decision.reasonCodes,
    facts: classified.facts,
  }))
}

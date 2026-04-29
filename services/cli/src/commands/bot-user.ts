import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { parse as parseYaml } from "yaml"
import { getFlag } from "../args.js"
import { deriveBotWallet } from "../bot-wallet.js"
import { apiRequest } from "../http.js"
import { exitWithUsage, printJson } from "../output.js"
import { resolveBaseUrl } from "../session.js"
import type { ParsedArgs } from "../types.js"

type BotUserConfig = {
  avatar_ref?: string
  bio?: string
  cover_ref?: string
  display_name?: string
  handle: string
}

function stringField(value: unknown, field: string, options: { required?: boolean } = {}): string | undefined {
  if (value === undefined || value === null) {
    if (options.required) {
      throw new Error(`user.yaml missing required ${field}`)
    }
    return undefined
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`user.yaml ${field} must be a non-empty string`)
  }
  return value.trim()
}

function readBotUserConfig(dir: string): BotUserConfig {
  const userYamlPath = join(resolve(dir), "user.yaml")
  const parsed = parseYaml(readFileSync(userYamlPath, "utf8")) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("user.yaml must be a YAML object")
  }

  const record = parsed as Record<string, unknown>
  return {
    handle: stringField(record.handle, "handle", { required: true }) as string,
    display_name: stringField(record.display_name, "display_name"),
    bio: stringField(record.bio, "bio"),
    avatar_ref: stringField(record.avatar_ref, "avatar_ref"),
    cover_ref: stringField(record.cover_ref, "cover_ref"),
  }
}

export async function runBotUser(action: string | undefined, args: ParsedArgs): Promise<void> {
  switch (action) {
    case "provision": {
      const dir = getFlag(args, "dir")
      const walletMasterSecret = process.env.BOT_WALLET_MASTER_SECRET
      const adminToken = getFlag(args, "admin-token") || process.env.PIRATE_ADMIN_TOKEN
      const baseUrl = resolveBaseUrl(getFlag(args, "base-url"))
      if (!dir) {
        exitWithUsage("Missing bot directory. Use --dir <path>.")
      }
      if (!walletMasterSecret) {
        exitWithUsage("Missing BOT_WALLET_MASTER_SECRET.")
      }
      if (!adminToken) {
        exitWithUsage("Missing admin token. Use --admin-token <token> or PIRATE_ADMIN_TOKEN.")
      }

      const config = readBotUserConfig(dir)
      const wallet = deriveBotWallet({ handle: config.handle, walletMasterSecret })
      const response = await apiRequest<unknown>({
        baseUrl,
        path: "/admin/bot-users/provision",
        method: "POST",
        adminToken,
        body: {
          ...config,
          handle: wallet.handle,
          wallet_address: wallet.walletAddress,
        },
      })
      printJson(response)
      return
    }
    case "token": {
      const handle = getFlag(args, "handle")
      const adminToken = getFlag(args, "admin-token") || process.env.PIRATE_ADMIN_TOKEN
      const baseUrl = resolveBaseUrl(getFlag(args, "base-url"))
      if (!handle) {
        exitWithUsage("Missing bot handle. Use --handle <handle.pirate>.")
      }
      if (!adminToken) {
        exitWithUsage("Missing admin token. Use --admin-token <token> or PIRATE_ADMIN_TOKEN.")
      }

      const response = await apiRequest<unknown>({
        baseUrl,
        path: `/admin/bot-users/handle/${encodeURIComponent(handle)}/token`,
        method: "POST",
        adminToken,
        body: {},
      })
      printJson(response)
      return
    }
    case "derive-wallet": {
      const handle = getFlag(args, "handle")
      const walletMasterSecret = process.env.BOT_WALLET_MASTER_SECRET
      if (!handle) {
        exitWithUsage("Missing bot handle. Use --handle <handle.pirate>.")
      }
      if (!walletMasterSecret) {
        exitWithUsage("Missing BOT_WALLET_MASTER_SECRET.")
      }

      const wallet = deriveBotWallet({ handle, walletMasterSecret })
      printJson({
        handle: wallet.handle,
        wallet_address: wallet.walletAddress,
        source_provider: "bot",
        source_subject: `bot:${wallet.handle}`,
        attachment_kind: "external",
      })
      return
    }
    default:
      exitWithUsage("Usage: pirate bot-user <provision|token|derive-wallet>")
  }
}

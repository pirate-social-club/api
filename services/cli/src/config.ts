import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { AuthState } from "./types.js"

const CONFIG_DIR = join(homedir(), ".config", "pirate")
const AUTH_PATH = join(CONFIG_DIR, "auth.json")
const SEED_ACCOUNTS_PATH = join(CONFIG_DIR, "seed-accounts.json")

export function getAuthPath(): string {
  return AUTH_PATH
}

export function getSeedAccountsPath(): string {
  return SEED_ACCOUNTS_PATH
}

export function readAuthState(): AuthState | null {
  if (!existsSync(AUTH_PATH)) {
    return null
  }
  try {
    return JSON.parse(readFileSync(AUTH_PATH, "utf8")) as AuthState
  } catch (error) {
    throw new Error(`Invalid Pirate auth state at ${AUTH_PATH}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function writeAuthState(state: AuthState): void {
  mkdirSync(dirname(AUTH_PATH), { recursive: true, mode: 0o700 })
  writeFileSync(AUTH_PATH, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  chmodSync(AUTH_PATH, 0o600)
}

export function clearAuthState(): void {
  writeAuthState({
    mode: "user",
    base_url: "",
    access_token: "",
    user_id: "",
    issued_at: null,
    expires_at: null,
    token_type: "Bearer",
  })
}

export function readSeedAccounts(path = SEED_ACCOUNTS_PATH): Record<string, string> {
  if (!existsSync(path)) {
    return {}
  }
  const parsed = readSeedAccountsRaw(path)
  return Object.fromEntries(
    Object.entries(parsed).flatMap(([alias, value]) => {
      const userId = seedAccountUserId(value)
      return userId ? [[alias, userId]] : []
    }),
  )
}

export function readSeedAccountsRaw(path = SEED_ACCOUNTS_PATH): Record<string, unknown> {
  if (!existsSync(path)) {
    return {}
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid seed accounts file: ${path}`)
  }
  return parsed as Record<string, unknown>
}

export function writeSeedAccounts(accounts: Record<string, string>, path = SEED_ACCOUNTS_PATH): void {
  const existing = readSeedAccountsRaw(path)
  const next: Record<string, unknown> = { ...existing }
  for (const [alias, userId] of Object.entries(accounts)) {
    const current = next[alias]
    next[alias] = current && typeof current === "object" && !Array.isArray(current)
      ? { ...current, user_id: userId }
      : userId
  }
  writeSeedAccountsRaw(next, path)
}

export function writeSeedAccountEntries(entries: Record<string, unknown>, path = SEED_ACCOUNTS_PATH): void {
  writeSeedAccountsRaw({ ...readSeedAccountsRaw(path), ...entries }, path)
}

function writeSeedAccountsRaw(accounts: Record<string, unknown>, path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(accounts, null, 2)}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
}

function seedAccountUserId(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim()
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const userId = (value as Record<string, unknown>).user_id
    return typeof userId === "string" && userId.trim() ? userId.trim() : null
  }
  return null
}

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { AuthState } from "./types.js"

const CONFIG_DIR = join(homedir(), ".config", "pirate")
const AUTH_PATH = join(CONFIG_DIR, "auth.json")

export function getAuthPath(): string {
  return AUTH_PATH
}

export function readAuthState(): AuthState | null {
  if (!existsSync(AUTH_PATH)) {
    return null
  }
  return JSON.parse(readFileSync(AUTH_PATH, "utf8")) as AuthState
}

export function writeAuthState(state: AuthState): void {
  mkdirSync(dirname(AUTH_PATH), { recursive: true, mode: 0o700 })
  writeFileSync(AUTH_PATH, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  chmodSync(AUTH_PATH, 0o600)
}

export function clearAuthState(): void {
  writeAuthState({
    base_url: "",
    access_token: "",
    user_id: "",
    issued_at: null,
    expires_at: null,
    token_type: "Bearer",
  })
}

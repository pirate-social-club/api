export type AuthState = {
  mode?: "user" | "admin"
  base_url: string
  access_token?: string
  admin_token?: string
  admin_as_user_id?: string
  user_id: string
  issued_at: string | null
  expires_at: string | null
  token_type: "Bearer"
}

export type ParsedArgs = {
  positionals: string[]
  flags: Record<string, string | boolean>
}

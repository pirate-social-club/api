export type AuthState = {
  base_url: string
  access_token: string
  user_id: string
  issued_at: string | null
  expires_at: string | null
  token_type: "Bearer"
}

export type ParsedArgs = {
  positionals: string[]
  flags: Record<string, string | boolean>
}

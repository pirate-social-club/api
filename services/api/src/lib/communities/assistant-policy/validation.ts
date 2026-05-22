export type AssistantContextMode = "live_sql" | "summary_cache" | "hybrid_vector"
export type AssistantActionMode = "answer_only" | "draft_only" | "confirmed_writes"
export type AssistantVoiceMode = "off" | "transcription_only" | "voice_replies"
export type AssistantSttProvider = "mistral" | "openai" | "none"

export type AssistantOpenRouterKeyStatus =
  | { kind: "missing" }
  | { kind: "connected"; last4: string; connectedAt?: string }
  | { kind: "invalid"; last4: string; message: string }

export type CommunityAssistantPolicySettingsInput = {
  enabled: boolean
  displayName: string
  shortBio: string
  systemPrompt: string
  defaultPrompt: string
  starterPrompts: string[]
  selectedModelId: string
  openRouterKeyStatus: AssistantOpenRouterKeyStatus
  contextMode: AssistantContextMode
  actionMode: AssistantActionMode
  requireModeratorApprovalForWrites: boolean
  retentionDays: number
  maxContextThreads: number
  maxLookbackDays: number | null
  perUserDailyMessageCap: number | null
  voiceMode: AssistantVoiceMode
  sttProvider: AssistantSttProvider
}

export type CommunityAssistantPolicyValidationResult =
  | { valid: true; data: CommunityAssistantPolicySettingsInput }
  | { valid: false; errors: string[] }

const CONTEXT_MODES: readonly AssistantContextMode[] = ["live_sql", "summary_cache", "hybrid_vector"]
const ACTION_MODES: readonly AssistantActionMode[] = ["answer_only", "draft_only", "confirmed_writes"]
const VOICE_MODES: readonly AssistantVoiceMode[] = ["off", "transcription_only", "voice_replies"]
const STT_PROVIDERS: readonly AssistantSttProvider[] = ["mistral", "openai", "none"]

function isRecord(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input)
}

function requiredString(
  input: Record<string, unknown>,
  field: string,
  errors: string[],
  options: {
    maxLength?: number
    required?: boolean
    trim?: boolean
  } = {},
): string {
  const value = input[field]
  if (typeof value !== "string") {
    errors.push(`${field} must be a string`)
    return ""
  }
  const normalized = options.trim ? value.trim() : value
  if ((options.required ?? false) && normalized.length === 0) {
    errors.push(`${field} is required`)
  }
  if (options.maxLength != null && normalized.length > options.maxLength) {
    errors.push(`${field} must be at most ${options.maxLength} characters`)
  }
  return normalized
}

function enumValue<T extends string>(
  input: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
  errors: string[],
): T {
  const value = input[field]
  if (typeof value === "string" && allowed.includes(value as T)) {
    return value as T
  }
  errors.push(`${field} must be one of: ${allowed.join(", ")}`)
  return allowed[0]
}

function requiredIntegerInRange(
  input: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
  errors: string[],
): number {
  const value = input[field]
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    errors.push(`${field} must be an integer from ${min} to ${max}`)
    return min
  }
  return value
}

function nullableIntegerInRange(
  input: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
  errors: string[],
): number | null {
  const value = input[field]
  if (value == null) {
    return null
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    errors.push(`${field} must be null or an integer from ${min} to ${max}`)
    return null
  }
  return value
}

function validateOpenRouterKeyStatus(
  input: unknown,
  errors: string[],
): AssistantOpenRouterKeyStatus {
  if (!isRecord(input)) {
    errors.push("openRouterKeyStatus must be an object")
    return { kind: "missing" }
  }

  if (input.kind === "missing") {
    return { kind: "missing" }
  }

  if (input.kind === "connected") {
    const last4 = typeof input.last4 === "string" ? input.last4.trim() : ""
    if (!last4) {
      errors.push("openRouterKeyStatus.last4 is required for connected keys")
    }
    return {
      kind: "connected",
      last4,
      ...(typeof input.connectedAt === "string" ? { connectedAt: input.connectedAt } : {}),
    }
  }

  if (input.kind === "invalid") {
    const last4 = typeof input.last4 === "string" ? input.last4.trim() : ""
    const message = typeof input.message === "string" ? input.message.trim() : ""
    if (!last4) {
      errors.push("openRouterKeyStatus.last4 is required for invalid keys")
    }
    if (!message) {
      errors.push("openRouterKeyStatus.message is required for invalid keys")
    }
    return { kind: "invalid", last4, message }
  }

  errors.push("openRouterKeyStatus.kind must be missing, connected, or invalid")
  return { kind: "missing" }
}

function validateStarterPrompts(input: unknown, errors: string[]): string[] {
  if (!Array.isArray(input)) {
    errors.push("starterPrompts must be an array")
    return []
  }
  if (input.length > 5) {
    errors.push("starterPrompts must contain at most 5 items")
  }

  return input.map((prompt, index) => {
    if (typeof prompt !== "string") {
      errors.push(`starterPrompts[${index}] must be a string`)
      return ""
    }
    if (prompt.length > 200) {
      errors.push(`starterPrompts[${index}] must be at most 200 characters`)
    }
    return prompt
  })
}

export function validateCommunityAssistantPolicySettings(
  input: unknown,
): CommunityAssistantPolicyValidationResult {
  const errors: string[] = []
  if (!isRecord(input)) {
    return { valid: false, errors: ["assistant policy settings must be an object"] }
  }

  const enabled = input.enabled
  if (typeof enabled !== "boolean") {
    errors.push("enabled must be a boolean")
  }
  const enabledValue = typeof enabled === "boolean" ? enabled : false

  const displayName = requiredString(input, "displayName", errors, {
    maxLength: 64,
    required: true,
    trim: true,
  })
  const shortBio = requiredString(input, "shortBio", errors, { maxLength: 280 })
  const systemPrompt = requiredString(input, "systemPrompt", errors, { maxLength: 8000 })
  const defaultPrompt = requiredString(input, "defaultPrompt", errors, { maxLength: 1000 })
  const starterPrompts = validateStarterPrompts(input.starterPrompts, errors)
  const selectedModelId = requiredString(input, "selectedModelId", errors, {
    required: true,
    trim: true,
  })
  const openRouterKeyStatus = validateOpenRouterKeyStatus(input.openRouterKeyStatus, errors)
  if (enabledValue && openRouterKeyStatus.kind !== "connected") {
    errors.push("enabled assistant requires a connected OpenRouter key")
  }

  const contextMode = enumValue(input, "contextMode", CONTEXT_MODES, errors)
  const actionMode = enumValue(input, "actionMode", ACTION_MODES, errors)
  const retentionDays = requiredIntegerInRange(input, "retentionDays", 1, 3650, errors)
  const maxContextThreads = requiredIntegerInRange(input, "maxContextThreads", 1, 50, errors)
  const maxLookbackDays = nullableIntegerInRange(input, "maxLookbackDays", 1, 365, errors)
  const perUserDailyMessageCap = nullableIntegerInRange(input, "perUserDailyMessageCap", 1, 10000, errors)
  const voiceMode = enumValue(input, "voiceMode", VOICE_MODES, errors)
  const sttProvider = enumValue(input, "sttProvider", STT_PROVIDERS, errors)

  const requireModeratorApprovalForWrites = input.requireModeratorApprovalForWrites
  if (typeof requireModeratorApprovalForWrites !== "boolean") {
    errors.push("requireModeratorApprovalForWrites must be a boolean")
  }
  const requireModeratorApprovalForWritesValue = typeof requireModeratorApprovalForWrites === "boolean"
    ? requireModeratorApprovalForWrites
    : false
  if (actionMode === "confirmed_writes" && !requireModeratorApprovalForWritesValue) {
    errors.push("confirmed writes require moderator approval")
  }

  if (errors.length > 0) {
    return { valid: false, errors }
  }

  return {
    valid: true,
    data: {
      enabled: enabledValue,
      displayName,
      shortBio,
      systemPrompt,
      defaultPrompt,
      starterPrompts,
      selectedModelId,
      openRouterKeyStatus,
      contextMode,
      actionMode,
      requireModeratorApprovalForWrites: requireModeratorApprovalForWritesValue,
      retentionDays,
      maxContextThreads,
      maxLookbackDays,
      perUserDailyMessageCap,
      voiceMode,
      sttProvider,
    },
  }
}

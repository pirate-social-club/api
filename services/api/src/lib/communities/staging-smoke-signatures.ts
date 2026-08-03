const LEGACY_SMOKE_NAME = /^(?:Community Create CI Smoke|D1 Provisioning Smoke|Song Submit CI Smoke)\b/u
const GATE_BUILDER_NAME = /^Gate builder staging \d{13}-[0-9a-f]{6}$/u
const GEORGIA_PLACE_NAME = /^Georgia Place Smoke \d{13}-[0-9a-f]{6}$/u

export const STAGING_SMOKE_DESCRIPTIONS = new Set([
  "Ephemeral staging smoke community for the create/provisioning path.",
  "Ephemeral staging smoke community for the song-submit path.",
  "Manual staging smoke community for the D1 provisioning seam.",
])

export function isRecognizedStagingSmoke(input: { display_name?: unknown; description?: unknown }): boolean {
  const displayName = String(input.display_name ?? "")
  const description = String(input.description ?? "")
  return STAGING_SMOKE_DESCRIPTIONS.has(description)
    || LEGACY_SMOKE_NAME.test(displayName)
    || isMachineGeneratedStagingSmokeName(displayName)
}

export function isMachineGeneratedStagingSmokeName(displayName: string): boolean {
  return GATE_BUILDER_NAME.test(displayName) || GEORGIA_PLACE_NAME.test(displayName)
}

import { printText } from "./output.js"

export const USAGE_TEXT = [
  "Pirate CLI",
  "",
  "Commands:",
  "  pirate auth login --jwt <token> [--base-url <url>]",
  "  pirate auth me",
  "  pirate auth logout",
  "  pirate onboarding status",
  "  pirate verify human start [--provider self|very]",
  "  pirate verify human status --session-id <id>",
  "  pirate verify human complete --session-id <id> [--attestation-id <id>] [--proof-hash <hash>]",
  "  pirate verify namespace start <root>",
  "  pirate verify namespace complete <session_id> [--restart-challenge]",
  "  pirate verify namespace status <session_id|verification_id> [--kind session|verification|auto]",
  "  pirate community create --display-name <name> --namespace-verification-id <id> [--description <text>]",
  "  pirate community get <community_id>",
  "  pirate job get <job_id>",
  "  pirate post create <community_id> --title <title> --body <body> [--idempotency-key <key>]",
  "  pirate post get <post_id> [--locale <locale>]",
].join("\n")

export function printUsage(): void {
  printText(USAGE_TEXT)
}

import { apiRoutes, type OnboardingStatus } from "@pirate/api-contracts"
import { apiRequest } from "../http.js"
import { exitWithUsage, printJson } from "../output.js"
import { requireStoredSession } from "../session.js"

export async function runOnboarding(action: string | undefined): Promise<void> {
  if (action !== "status") {
    exitWithUsage("Usage: pirate onboarding status")
  }
  const session = requireStoredSession()
  const result = await apiRequest<OnboardingStatus>({
    baseUrl: session.baseUrl,
    path: apiRoutes.onboardingStatus,
    accessToken: session.accessToken,
  })
  printJson(result)
}

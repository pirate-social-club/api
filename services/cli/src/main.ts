import { hasFlag, parseArgs } from "./args.js"
import { runAuth } from "./commands/auth.js"
import { runComment } from "./commands/comment.js"
import { runCommunity } from "./commands/community.js"
import { runJob } from "./commands/job.js"
import { runOnboarding } from "./commands/onboarding.js"
import { runPost } from "./commands/post.js"
import { runProfile } from "./commands/profile.js"
import { runVerify } from "./commands/verify.js"
import { exitWithUsage } from "./output.js"
import { printUsage } from "./usage.js"

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv)
  const [group, action, ...rest] = args.positionals

  if (!group || hasFlag(args, "help")) {
    printUsage()
    return
  }

  switch (group) {
    case "auth":
      await runAuth(action, args)
      return
    case "onboarding":
      await runOnboarding(action)
      return
    case "verify":
      await runVerify(action, rest, args)
      return
    case "community":
      await runCommunity(action, rest, args)
      return
    case "job":
      await runJob(action, rest)
      return
    case "post":
      await runPost(action, rest, args)
      return
    case "comment":
      await runComment(action, rest, args)
      return
    case "profile":
      await runProfile(action, args)
      return
    default:
      exitWithUsage(`Unknown command group: ${group}`)
  }
}

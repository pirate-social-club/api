import { JsonRpcProvider, getAddress } from "ethers"
import type { Env } from "../src/env"
import {
  setStoryAccessSignerAuthorization,
  setStoryPublishOperatorAuthorization,
} from "../src/lib/story/story-runtime-authorization"
import { resolveStoryChainId, resolveStoryRpcUrl } from "../src/lib/story/story-runtime-config"
import { readDevVarsFromCwd, readWranglerVarsFromCwd } from "./_lib/dev-vars"

function arg(name: string): string {
  const prefix = `${name}=`
  const value = process.argv.slice(2).find((entry) => entry.startsWith(prefix))?.slice(prefix.length).trim()
  if (!value) throw new Error(`${name}=ADDRESS is required`)
  return getAddress(value)
}

async function main(): Promise<void> {
  const env = {
    ...readWranglerVarsFromCwd("wrangler.jsonc", "development"),
    ...readDevVarsFromCwd(),
    ...process.env,
  } as Env
  const oldAddress = arg("--old-address")
  const operatorAddress = arg("--operator-address")
  const accessAddress = arg("--access-address")
  const revokeOld = process.argv.slice(2).includes("--revoke-old")
  const provider = new JsonRpcProvider(resolveStoryRpcUrl(env), resolveStoryChainId(env))
  try {
    await setStoryPublishOperatorAuthorization({ env, provider, operatorAddress, active: true })
    await setStoryAccessSignerAuthorization({ env, provider, signerAddress: accessAddress, active: true })
    if (revokeOld) {
      await setStoryPublishOperatorAuthorization({ env, provider, operatorAddress: oldAddress, active: false })
      await setStoryAccessSignerAuthorization({ env, provider, signerAddress: oldAddress, active: false })
    }
    console.log(JSON.stringify({
      operator: operatorAddress,
      access_controller: accessAddress,
      revoked: revokeOld ? oldAddress : null,
    }, null, 2))
  } finally {
    void provider.destroy()
  }
}

await main()

import { TypedDataEncoder, getAddress, id } from "ethers"
import type { Env } from "../../types"
import { executeChipotleLitAction } from "../evm-chipotle"
import { parseExpectedEvmAddress } from "../evm-signer"
import { resolveStoryAccessControllerPkpExecutionConfig } from "./access-controller-pkp"
import { resolveStoryChainId } from "./story-runtime-config"

type AccessProofTypedData = {
  AccessProof: Array<{
    name: string
    type: string
  }>
}

export type StoryAccessScope = "asset.owner" | "asset.share"

export type StorySignedAccessProof = {
  digest: `0x${string}`
  signature: `0x${string}`
  signerAddress: string
  proof: {
    vaultUuid: number
    caller: string
    accessRef: `0x${string}`
    scope: `0x${string}`
    expiry: number
    namespace: `0x${string}`
  }
}

const SCOPE_HASHES = {
  "asset.owner": id("asset.owner"),
  "asset.share": id("asset.share"),
} as const

let testSigner: ((input: {
  env: Env
  vaultUuid: number
  callerAddress: string
  accessRef: `0x${string}`
  scope: StoryAccessScope
  expiry: number
  namespace: `0x${string}`
}) => Promise<StorySignedAccessProof>) | null = null

export function setStoryAccessProofSignerForTests(
  signer: ((input: {
    env: Env
    vaultUuid: number
    callerAddress: string
    accessRef: `0x${string}`
    scope: StoryAccessScope
    expiry: number
    namespace: `0x${string}`
  }) => Promise<StorySignedAccessProof>) | null,
): void {
  testSigner = signer
}

export async function generateStorySignedAccessProof(input: {
  env: Env
  vaultUuid: number
  callerAddress: string
  accessRef: `0x${string}`
  scope: StoryAccessScope
  expiry: number
  namespace: `0x${string}`
  verifyingContract: string
}): Promise<StorySignedAccessProof> {
  if (testSigner) {
    return await testSigner({
      env: input.env,
      vaultUuid: input.vaultUuid,
      callerAddress: input.callerAddress,
      accessRef: input.accessRef,
      scope: input.scope,
      expiry: input.expiry,
      namespace: input.namespace,
    })
  }

  const callerAddress = parseExpectedEvmAddress(input.callerAddress)
  if (!callerAddress) {
    throw new Error("callerAddress missing/invalid")
  }
  const verifyingContract = parseExpectedEvmAddress(input.verifyingContract)
  if (!verifyingContract) {
    throw new Error("verifyingContract missing/invalid")
  }
  const config = resolveStoryAccessControllerPkpExecutionConfig(input.env)
  if (!config.ok) throw new Error(config.error)
  if (!config.value) throw new Error("STORY_ACCESS_CONTROLLER_PKP_ADDRESS missing/invalid")

  const domain = {
    name: "PirateSignedAccess",
    version: "1",
    chainId: resolveStoryChainId(input.env),
    verifyingContract: getAddress(verifyingContract),
  }
  const types: AccessProofTypedData = {
    AccessProof: [
      { name: "vaultUuid", type: "uint32" },
      { name: "caller", type: "address" },
      { name: "accessRef", type: "bytes32" },
      { name: "scope", type: "bytes32" },
      { name: "expiry", type: "uint64" },
      { name: "namespace", type: "bytes32" },
    ],
  }
  const proof = {
    vaultUuid: input.vaultUuid,
    caller: getAddress(callerAddress),
    accessRef: input.accessRef,
    scope: SCOPE_HASHES[input.scope] as `0x${string}`,
    expiry: input.expiry,
    namespace: input.namespace,
  }
  const digest = TypedDataEncoder.hash(domain, types, proof) as `0x${string}`
  const litResponse = await executeChipotleLitAction({
    ...config.value.pkp,
    jsParams: {
      digest,
      expectedSignerAddress: config.value.pkp.pkpAddress,
    },
  })
  let parsed: Record<string, unknown> | null = null
  if (typeof litResponse.response === "string" && litResponse.response.trim()) {
    parsed = JSON.parse(litResponse.response) as Record<string, unknown>
  } else if (litResponse.response && typeof litResponse.response === "object" && !Array.isArray(litResponse.response)) {
    parsed = litResponse.response as Record<string, unknown>
  }
  const signature = typeof parsed?.signature === "string" ? parsed.signature as `0x${string}` : null
  const signerAddress = typeof parsed?.signerAddress === "string" ? parsed.signerAddress : config.value.pkp.pkpAddress
  if (!signature) {
    throw new Error("story_access_proof_signature_missing")
  }
  return {
    digest,
    signature,
    signerAddress,
    proof,
  }
}

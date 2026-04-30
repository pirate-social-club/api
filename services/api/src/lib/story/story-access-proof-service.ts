import { JsonRpcProvider, TypedDataEncoder, Wallet, getAddress, id } from "ethers"
import type { Env } from "../../env"
import { parseExpectedEvmAddress } from "../evm-signer"
import { resolveStoryAccessControllerDirectSigner } from "./story-direct-signer"
import { ensureStoryAccessSignerAuthorized } from "./story-runtime-authorization"
import { resolveStoryChainId, resolveStoryRpcUrl } from "./story-runtime-config"

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
  const config = resolveStoryAccessControllerDirectSigner(input.env)
  if (!config.ok) throw new Error(config.error)
  if (!config.value) throw new Error("STORY_ACCESS_CONTROLLER_PRIVATE_KEY missing/invalid")

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
  const provider = new JsonRpcProvider(resolveStoryRpcUrl(input.env), resolveStoryChainId(input.env))
  await ensureStoryAccessSignerAuthorized({
    env: input.env,
    provider,
    signerAddress: config.value.address,
  })
  const signer = new Wallet(config.value.privateKey, provider)
  const signature = await signer.signTypedData(domain, types, proof) as `0x${string}`
  return {
    digest,
    signature,
    signerAddress: signer.address,
    proof,
  }
}

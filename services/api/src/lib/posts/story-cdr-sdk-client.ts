import { access } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { PublicClient, WalletClient } from "viem"

export type StorageProvider = {
  upload(data: Uint8Array, options?: { pin?: boolean }): Promise<string>
  download(cid: string): Promise<Uint8Array>
}

type CdrClientInstance = {
  observer: {
    getGlobalPubKey(): Promise<Uint8Array>
  }
  uploader: {
    encryptDataKey(input: {
      dataKey: Uint8Array
      globalPubKey: Uint8Array
      label: Uint8Array
    }): Promise<{ raw: Uint8Array }>
  }
  consumer: {
    downloadFile(input: {
      uuid: number
      accessAuxData: `0x${string}`
      storageProvider: StorageProvider
      skipCidVerification: boolean
    }): Promise<{
      content: Uint8Array
      cid: string
      txHash: `0x${string}`
    }>
  }
}

type CdrClientConstructorParams = {
  network: string
  publicClient: PublicClient
  walletClient?: WalletClient
  dkgSource?: "evm-events" | "cosmos-abci"
  cometRpcUrl?: string
  minThresholdRatio?: number
  validationRpcUrls?: string[]
}

type CdrSdkModule = {
  CDRClient: new (params: CdrClientConstructorParams) => CdrClientInstance
  initWasm: () => Promise<void>
}

const moduleDir = dirname(fileURLToPath(import.meta.url))

function buildSearchRoots(start: string): string[] {
  const roots: string[] = []
  let current = resolve(start)

  while (true) {
    roots.push(current)
    const parent = dirname(current)
    if (parent === current) {
      break
    }
    current = parent
  }

  return roots
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function resolveCdrSdkDistModule(relativePath: string): Promise<string> {
  const explicitRoot = process.env.PIRATE_CDR_SDK_ROOT?.trim()
  const searchRoots = [
    ...(explicitRoot ? [resolve(explicitRoot)] : []),
    ...buildSearchRoots(process.cwd()),
    ...buildSearchRoots(moduleDir),
  ]
  const visited = new Set<string>()

  for (const root of searchRoots) {
    const candidates = [
      join(root, relativePath),
      join(root, "cdr-sdk", relativePath),
    ]

    for (const candidate of candidates) {
      if (visited.has(candidate)) {
        continue
      }
      visited.add(candidate)
      if (await pathExists(candidate)) {
        return candidate
      }
    }
  }

  throw new Error(`cdr_sdk_module_not_found:${relativePath}`)
}

const sdkModule = await import(
  pathToFileURL(await resolveCdrSdkDistModule("packages/sdk/dist/index.js")).href,
) as CdrSdkModule

export type CDRClient = CdrClientInstance
export const CDRClient = sdkModule.CDRClient
export const initWasm = sdkModule.initWasm

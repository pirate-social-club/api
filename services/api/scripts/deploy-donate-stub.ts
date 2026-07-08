import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { JsonRpcProvider, Wallet } from "ethers"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const serviceRoot = resolve(scriptDir, "..")
const artifactPath = resolve(serviceRoot, "out", "DonateStub.sol", "DonateStub.json")

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`${name} is required`)
  }
  return value
}

function optionalEnv(name: string): string | null {
  return process.env[name]?.trim() || null
}

function resolvePrivateKey(): string {
  return optionalEnv("ENDAOMENT_PAYOUT_PRIVATE_KEY")
    || optionalEnv("PIRATE_CHECKOUT_OPERATOR_PRIVATE_KEY")
    || requiredEnv("PIRATE_DONATE_STUB_DEPLOYER_PRIVATE_KEY")
}

function resolveRpcUrl(): string {
  return optionalEnv("ENDAOMENT_RPC_URL")
    || optionalEnv("PIRATE_CHECKOUT_RPC_URL")
    || requiredEnv("BASE_SEPOLIA_RPC_URL")
}

function resolveChainId(): number {
  const raw = optionalEnv("ENDAOMENT_CHAIN_ID")
    || optionalEnv("PIRATE_CHECKOUT_SOURCE_CHAIN_ID")
    || "84532"
  const chainId = Number(raw)
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error(`Invalid chain id: ${raw}`)
  }
  return chainId
}

function compileBytecode(): string {
  execFileSync("forge", [
    "build",
    "--root",
    serviceRoot,
    "--contracts",
    "scripts/smoke-contracts",
  ], {
    cwd: serviceRoot,
    stdio: ["ignore", "inherit", "inherit"],
  })
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"))
  const bytecode = artifact?.bytecode?.object
  if (typeof bytecode !== "string" || !/^0x[0-9a-fA-F]+$/u.test(bytecode)) {
    throw new Error("DonateStub artifact is missing valid bytecode")
  }
  return bytecode
}

async function main(): Promise<void> {
  const chainId = resolveChainId()
  const provider = new JsonRpcProvider(resolveRpcUrl(), chainId)
  const wallet = new Wallet(resolvePrivateKey(), provider)
  const bytecode = compileBytecode()
  const tx = await wallet.sendTransaction({ data: bytecode })
  console.log("[donate-stub] deployment submitted", JSON.stringify({
    chain_id: chainId,
    deployer: wallet.address,
    tx: tx.hash,
  }))
  const receipt = await tx.wait(1)
  if (!receipt || receipt.status !== 1 || !receipt.contractAddress) {
    throw new Error(`DonateStub deployment failed: ${tx.hash}`)
  }
  console.log("[donate-stub] deployed", JSON.stringify({
    address: receipt.contractAddress,
    chain_id: chainId,
    tx: tx.hash,
  }))
}

await main()

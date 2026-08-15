import { mkdir, open, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import { Wallet } from "ethers"

const outputDirectory = process.argv[2]
if (!outputDirectory) throw new Error("output directory is required")

const target = resolve(outputDirectory)
await mkdir(target, { recursive: false, mode: 0o700 })

const roles = ["custody", "purchase-operator", "platform-revenue"] as const
const addresses: Record<string, string> = {}
for (const role of roles) {
  const wallet = Wallet.createRandom()
  const path = resolve(target, `${role}.env`)
  if (!path.startsWith(`${target}/`)) throw new Error("invalid output path")
  const file = await open(path, "wx", 0o600)
  try {
    await file.writeFile(`WALLET_ADDRESS=${wallet.address}\nPRIVATE_KEY=${wallet.privateKey}\n`)
  } finally {
    await file.close()
  }
  addresses[role] = wallet.address
}
await writeFile(resolve(target, "addresses.json"), `${JSON.stringify(addresses, null, 2)}\n`, {
  flag: "wx",
  mode: 0o600,
})

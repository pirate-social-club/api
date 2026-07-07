import { describe, expect, test } from "bun:test"
import { Interface, Transaction, Wallet } from "ethers"
import {
  extractAlreadyKnownRawTransactionHash,
  sendContractTxWithPolicy,
} from "../src/lib/evm-direct-tx"

describe("evm direct tx", () => {
  test("coerces already-known raw transaction errors into a waitable response", async () => {
    const wallet = Wallet.createRandom()
    const iface = new Interface(["function ping()"])
    const rawTransaction = await wallet.signTransaction({
      chainId: 1315,
      type: 2,
      nonce: 7,
      to: "0x1111111111111111111111111111111111111111",
      data: iface.encodeFunctionData("ping"),
      value: 0n,
      gasLimit: 45_000n,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    })
    const expectedHash = Transaction.from(rawTransaction).hash
    const waited: Array<{ hash: string; confirms?: number; timeout?: number }> = []
    const provider = {
      getFeeData: async () => ({
        maxFeePerGas: 1_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
      }),
      estimateGas: async () => 30_000n,
      waitForTransaction: async (hash: string, confirms?: number, timeout?: number) => {
        waited.push({ hash, confirms, timeout })
        return { status: 1, hash }
      },
    }
    const signer = {
      address: wallet.address,
      sendTransaction: async () => {
        throw {
          message: "could not coalesce error",
          error: {
            code: -32000,
            message: "already known",
          },
          payload: {
            params: [rawTransaction],
          },
        }
      },
    }

    const response = await sendContractTxWithPolicy({
      provider: provider as never,
      signer: signer as never,
      contractAddress: "0x1111111111111111111111111111111111111111",
      abi: ["function ping()"],
      functionName: "ping",
      args: [],
      gasPolicy: {
        maxFeePerGasCapWei: 2_000_000_000n,
        maxPriorityFeePerGasCapWei: 2_000_000_000n,
        gasLimitCap: 100_000n,
        gasEstimateBufferBps: 10_000n,
      },
    })

    expect(response.hash).toBe(expectedHash)
    await response.wait(1, 30_000)
    expect(waited).toEqual([{ hash: expectedHash, confirms: 1, timeout: 30_000 }])
  })

  test("uses the default wait timeout for already-known transaction responses", async () => {
    const wallet = Wallet.createRandom()
    const iface = new Interface(["function ping()"])
    const rawTransaction = await wallet.signTransaction({
      chainId: 1315,
      type: 2,
      nonce: 8,
      to: "0x1111111111111111111111111111111111111111",
      data: iface.encodeFunctionData("ping"),
      value: 0n,
      gasLimit: 45_000n,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    })
    const expectedHash = Transaction.from(rawTransaction).hash
    const waited: Array<{ hash: string; confirms?: number; timeout?: number }> = []
    const provider = {
      getFeeData: async () => ({
        maxFeePerGas: 1_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
      }),
      estimateGas: async () => 30_000n,
      waitForTransaction: async (hash: string, confirms?: number, timeout?: number) => {
        waited.push({ hash, confirms, timeout })
        return { status: 1, hash }
      },
    }
    const signer = {
      address: wallet.address,
      sendTransaction: async () => {
        throw {
          message: "could not coalesce error",
          error: {
            code: -32000,
            message: "already known",
          },
          payload: {
            params: [rawTransaction],
          },
        }
      },
    }

    const response = await sendContractTxWithPolicy({
      provider: provider as never,
      signer: signer as never,
      contractAddress: "0x1111111111111111111111111111111111111111",
      abi: ["function ping()"],
      functionName: "ping",
      args: [],
      gasPolicy: {
        maxFeePerGasCapWei: 2_000_000_000n,
        maxPriorityFeePerGasCapWei: 2_000_000_000n,
        gasLimitCap: 100_000n,
        gasEstimateBufferBps: 10_000n,
      },
      defaultWaitTimeoutMs: 45_000,
    })

    await response.wait(1)
    expect(waited).toEqual([{ hash: expectedHash, confirms: 1, timeout: 45_000 }])
  })

  test("does not coerce unrelated transaction errors", async () => {
    expect(extractAlreadyKnownRawTransactionHash({
      error: {
        code: -32000,
        message: "nonce too low",
      },
      payload: {
        params: ["0x1234"],
      },
    })).toBeNull()
  })
})

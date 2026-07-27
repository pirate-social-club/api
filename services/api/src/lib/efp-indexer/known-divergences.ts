import type { Address, Hex } from "viem"

export type EfpKnownHostedDivergence = {
  listId: string
  target: Address
  finalAddTransactionHash: Hex
}

// Hosted EFP omits these effective edges. Each exception is admitted only after
// getAllListOps(slot) and the named transaction receipt independently confirm
// that the terminal on-chain operation is add.
export const EFP_KNOWN_HOSTED_DIVERGENCES: readonly EfpKnownHostedDivergence[] = [
  { listId: "44", target: "0xd178221f778a3f06a8fa98c9804ef68548639514", finalAddTransactionHash: "0xf5d5723e7ebf4f81a3515671ec884f646004bd6fa838f889a00ab7d0030f8889" },
  { listId: "71", target: "0xfed257209796eec486f2a1c0af1b330857e463c4", finalAddTransactionHash: "0x7adc2126219ceb53f41a20e0dd7c466ee9993432ca979043e61e5cbef9f583ab" },
  { listId: "71", target: "0x4b81691534af319ebaf7cc0ebcb69ebc9e0c6b36", finalAddTransactionHash: "0xee5f14e90e4631cacd39ca083b7195c03ca438de1c55ae9aaf71ba4f605a35d9" },
  { listId: "71", target: "0x93f436575f8104ba0f7871ca9d89544b898d4607", finalAddTransactionHash: "0xee5f14e90e4631cacd39ca083b7195c03ca438de1c55ae9aaf71ba4f605a35d9" },
  { listId: "71", target: "0x14546125429faac7f3aa78da1807069692ec7464", finalAddTransactionHash: "0xee5f14e90e4631cacd39ca083b7195c03ca438de1c55ae9aaf71ba4f605a35d9" },
  { listId: "71", target: "0x05977b2fb9b7ab3f3733b34350044a01a388579c", finalAddTransactionHash: "0xee5f14e90e4631cacd39ca083b7195c03ca438de1c55ae9aaf71ba4f605a35d9" },
  { listId: "5874", target: "0x3e443fa94ba7f2c055a92d46542c91a0bf87d54d", finalAddTransactionHash: "0xfbb2d97b7a8d3e317135049726e2551fdb20456240f9f5b0fa578a7b96fde8d9" },
  { listId: "5874", target: "0x32bafc56ba20b46c1bdc3f240e1e2e9fa1cec5b3", finalAddTransactionHash: "0x9d1c5956631427834dfac3a22742a3aebbe6268abbdc7487b03e3b791c61e700" },
  { listId: "9", target: "0x306793748bb2aef331d42a9c0c9183034fd24091", finalAddTransactionHash: "0x00cde5e90e2db24a785bf609eb57f1275b4dad5b977473cb9f76a2cdd6758905" },
  { listId: "9", target: "0x07c47d382183adc21cd8d9acf5905fa799825444", finalAddTransactionHash: "0xc176ce18d8bad6fecd67a208629914cba41e48e1ba27aa9fe840d87fab48d935" },
  { listId: "9", target: "0xb6f6dce6000ca88cc936b450cedb16a5c15f157f", finalAddTransactionHash: "0xe65523ab749a81258ba0ae3d20b60327909b1922884e393bf0db61d8f91e7202" },
  { listId: "9", target: "0x00000152996f3d3e94540cd03a3a2e711f52bead", finalAddTransactionHash: "0x505221c382699da894d58b966f042e9280f441bbbb53cbd26bf7e449b438f5be" },
  { listId: "44718", target: "0x0008906ca2e1d42dfb6bbcda7f9b709a0cfa8dfc", finalAddTransactionHash: "0x643dd371e55ff5b68e492ead413a33a4b61f186b5c1cf4d65b1f98f2bd590138" },
  { listId: "44460", target: "0x0008906ca2e1d42dfb6bbcda7f9b709a0cfa8dfc", finalAddTransactionHash: "0xfd9bc717dfce4d49635ba5dbc4ebfc3f73e15c40579f041f0294078c5bd88c56" },
  { listId: "44777", target: "0x0008906ca2e1d42dfb6bbcda7f9b709a0cfa8dfc", finalAddTransactionHash: "0x13255f730445e27ab0f3359060bf9ec38dc21377acd6ebd251668cf28a06bb01" },
  { listId: "44277", target: "0x0008906ca2e1d42dfb6bbcda7f9b709a0cfa8dfc", finalAddTransactionHash: "0x2e5dc8b3c5f5f4e6ea746b2f9ffa0e18668294b0344f5173c2af5d95b65e2a10" },
  { listId: "44325", target: "0x0008906ca2e1d42dfb6bbcda7f9b709a0cfa8dfc", finalAddTransactionHash: "0xff1455b69ecaaf85e004b9ae83066013ace706dd9bbed1778e4d33e43750ba96" },
] as const

export function isEfpKnownHostedDivergence(listId: string, target: Address): boolean {
  return EFP_KNOWN_HOSTED_DIVERGENCES.some(
    (item) => item.listId === listId && item.target === target.toLowerCase(),
  )
}

export const MEGAPOT_JACKPOT_READ_ABI = [
  "function allowTicketPurchases() view returns (bool)",
  "function currentDrawingId() view returns (uint256)",
  "function drawingDurationInSeconds() view returns (uint256)",
  "function getDrawingState(uint256 drawingId) view returns ((uint256 prizePool, uint256 ticketPrice, uint256 edgePerTicket, uint256 referralWinShare, uint256 referralFee, uint256 globalTicketsBought, uint256 lpEarnings, uint256 drawingTime, uint256 winningTicket, uint8 ballMax, uint8 bonusballMax, address payoutCalculator, bool jackpotLock))",
  "function jackpotNFT() view returns (address)",
  "function maxReferrers() view returns (uint256)",
  "function ticketPrice() view returns (uint256)",
  "function usdc() view returns (address)",
] as const

export const MEGAPOT_RANDOM_BUYER_ABI = [
  "event RandomTicketsBought(address indexed recipient, uint256 indexed drawingId, uint256 count, uint256 cost, uint256[] ticketIds)",
  "function jackpot() view returns (address)",
  "function usdc() view returns (address)",
  "function buyTickets(uint256 _count, address _recipient, address[] _referrers, uint256[] _referralSplitBps, bytes32 _source) returns (uint256[] ticketIds)",
] as const

export const MEGAPOT_TICKET_NFT_ABI = [
  "function getTicketInfo(uint256 ticketId) view returns ((uint256 drawingId, uint256 packedTicket, bytes32 referralScheme))",
  "function jackpot() view returns (address)",
  "function ownerOf(uint256 ticketId) view returns (address)",
] as const

export const MEGAPOT_CLAIM_ERRORS_ABI = [
  "error NoTicketsToClaim()",
  "error NotTicketOwner()",
] as const

export const REWARD_TICKET_PURCHASE_ESCROW_ABI = [
  "function purchase(bytes32 operationId,uint256 count,uint256 intendedDrawingId,uint256 expectedTicketPriceAtomic,bytes32 source) returns (uint256[] ticketIds)",
] as const

export const REWARD_TICKET_COMMITMENT_REGISTRY_ABI = [
  "function publish(address jackpot,uint256 drawingId,bytes32 rootHash,uint32 leafCount,bytes32 termsVersionHash)",
] as const

export const REWARD_TICKET_SAFE_CLAIM_MODULE_ABI = [
  "function claim(bytes32 operationId,uint256[] ticketIds) returns (bool)",
] as const

import { GLOBAL_HANDLE_FIRST_NAME_TERMS } from "./global-handle-first-name-terms"

export type GlobalHandlePremiumTerm = {
  term: string
  type: "commercial_keyword" | "common_word" | "first_name" | "platform" | "surname" | "trophy"
  multiplier: number
  source_note: string
}

const MANUAL_GLOBAL_HANDLE_PREMIUM_TERMS = [
  { term: "smith", type: "surname", multiplier: 8, source_note: "Census-style top surname seed" },
  { term: "garcia", type: "surname", multiplier: 8, source_note: "Census-style top surname seed" },
  { term: "studio", type: "common_word", multiplier: 4, source_note: "Common brandable word seed" },
  { term: "bright", type: "common_word", multiplier: 4, source_note: "Common brandable word seed" },
  { term: "captain", type: "common_word", multiplier: 3, source_note: "Pirate-adjacent common word seed" },
  { term: "king", type: "trophy", multiplier: 10, source_note: "Prestige/royalty exact-match seed" },
  { term: "queen", type: "trophy", multiplier: 8, source_note: "Prestige/royalty exact-match seed" },
  { term: "prince", type: "trophy", multiplier: 6, source_note: "Prestige/royalty exact-match seed" },
  { term: "princess", type: "trophy", multiplier: 10, source_note: "Prestige/royalty exact-match seed" },
  { term: "royal", type: "trophy", multiplier: 6, source_note: "Prestige/royalty exact-match seed" },
  { term: "crown", type: "trophy", multiplier: 8, source_note: "Prestige/royalty exact-match seed; crown emoji is separately reserved" },
  { term: "sheikh", type: "trophy", multiplier: 10, source_note: "Prestige/royalty exact-match seed" },
  { term: "sultan", type: "trophy", multiplier: 8, source_note: "Prestige/royalty exact-match seed" },
  { term: "emir", type: "trophy", multiplier: 6, source_note: "Prestige/royalty exact-match seed" },
  { term: "lord", type: "trophy", multiplier: 6, source_note: "Prestige/royalty exact-match seed" },
  { term: "duke", type: "trophy", multiplier: 4, source_note: "Prestige/royalty exact-match seed" },
  { term: "baron", type: "trophy", multiplier: 5, source_note: "Prestige/royalty exact-match seed" },
  { term: "boss", type: "trophy", multiplier: 5, source_note: "Prestige/status exact-match seed" },
  { term: "chief", type: "trophy", multiplier: 5, source_note: "Prestige/status exact-match seed" },
  { term: "gold", type: "common_word", multiplier: 8, source_note: "High-signal valuable common word seed" },
  { term: "treasure", type: "common_word", multiplier: 20, source_note: "Pirate-adjacent valuable common word seed" },
  { term: "ship", type: "common_word", multiplier: 6, source_note: "Pirate-adjacent common word seed" },
  { term: "rum", type: "common_word", multiplier: 4, source_note: "Pirate-adjacent short common word seed" },
  { term: "map", type: "common_word", multiplier: 4, source_note: "Pirate-adjacent short common word seed" },
  { term: "sea", type: "common_word", multiplier: 4, source_note: "Pirate-adjacent short common word seed" },
  { term: "loan", type: "commercial_keyword", multiplier: 50, source_note: "High-commercial-intent keyword seed" },
  { term: "loans", type: "commercial_keyword", multiplier: 50, source_note: "High-commercial-intent keyword seed" },
  { term: "tax", type: "commercial_keyword", multiplier: 25, source_note: "High-commercial-intent keyword seed" },
  { term: "law", type: "commercial_keyword", multiplier: 25, source_note: "High-commercial-intent keyword seed" },
  { term: "legal", type: "commercial_keyword", multiplier: 20, source_note: "High-commercial-intent keyword seed" },
  { term: "money", type: "commercial_keyword", multiplier: 20, source_note: "High-commercial-intent keyword seed" },
  { term: "cash", type: "commercial_keyword", multiplier: 20, source_note: "High-commercial-intent keyword seed" },
  { term: "trade", type: "commercial_keyword", multiplier: 16, source_note: "Commercial keyword seed" },
  { term: "market", type: "commercial_keyword", multiplier: 16, source_note: "Commercial keyword seed" },
  { term: "shop", type: "commercial_keyword", multiplier: 12, source_note: "Commercial keyword seed" },
  { term: "store", type: "commercial_keyword", multiplier: 12, source_note: "Commercial keyword seed" },
  { term: "crypto", type: "commercial_keyword", multiplier: 12, source_note: "Commercial keyword seed" },
  { term: "lawyer", type: "commercial_keyword", multiplier: 25, source_note: "High-commercial-intent keyword seed" },
  { term: "insurance", type: "commercial_keyword", multiplier: 25, source_note: "High-commercial-intent keyword seed" },
  { term: "hosting", type: "commercial_keyword", multiplier: 12, source_note: "Commercial keyword seed" },
] as const satisfies readonly GlobalHandlePremiumTerm[]

export const GLOBAL_HANDLE_PREMIUM_TERMS: readonly GlobalHandlePremiumTerm[] = [
  ...GLOBAL_HANDLE_FIRST_NAME_TERMS,
  // Appended last so manual trophy/commercial classifications override generated first-name duplicates.
  ...MANUAL_GLOBAL_HANDLE_PREMIUM_TERMS,
]

export const GLOBAL_HANDLE_RESERVED_TERMS = new Set([
  "admin",
  "administrator",
  "ai",
  "bank",
  "btc",
  "casino",
  "dao",
  "eth",
  "god",
  "help",
  "mod",
  "moderator",
  "nft",
  "official",
  "owner",
  "pay",
  "pirate",
  "root",
  "security",
  "sex",
  "staff",
  "support",
  "wallet",
  "xn--2p8h",
])

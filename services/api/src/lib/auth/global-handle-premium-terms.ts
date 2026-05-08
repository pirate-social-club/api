export type GlobalHandlePremiumTerm = {
  term: string
  type: "commercial_keyword" | "common_word" | "first_name" | "platform" | "surname" | "trophy"
  multiplier: number
  source_note: string
}

export const GLOBAL_HANDLE_PREMIUM_TERMS: readonly GlobalHandlePremiumTerm[] = [
  { term: "olivia", type: "first_name", multiplier: 10, source_note: "SSA-style top first name seed" },
  { term: "liam", type: "first_name", multiplier: 10, source_note: "SSA-style top first name seed" },
  { term: "maria", type: "first_name", multiplier: 6, source_note: "Common international first name seed" },
  { term: "michael", type: "first_name", multiplier: 6, source_note: "Common first name seed" },
  { term: "smith", type: "surname", multiplier: 8, source_note: "Census-style top surname seed" },
  { term: "garcia", type: "surname", multiplier: 8, source_note: "Census-style top surname seed" },
  { term: "studio", type: "common_word", multiplier: 4, source_note: "Common brandable word seed" },
  { term: "bright", type: "common_word", multiplier: 4, source_note: "Common brandable word seed" },
  { term: "captain", type: "common_word", multiplier: 3, source_note: "Pirate-adjacent common word seed" },
  { term: "loan", type: "commercial_keyword", multiplier: 50, source_note: "High-commercial-intent keyword seed" },
  { term: "loans", type: "commercial_keyword", multiplier: 50, source_note: "High-commercial-intent keyword seed" },
  { term: "lawyer", type: "commercial_keyword", multiplier: 25, source_note: "High-commercial-intent keyword seed" },
  { term: "insurance", type: "commercial_keyword", multiplier: 25, source_note: "High-commercial-intent keyword seed" },
  { term: "hosting", type: "commercial_keyword", multiplier: 12, source_note: "Commercial keyword seed" },
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

// Public decoded domain types for the global bookings repository. These are the repository's OUTPUT
// shapes (camelCase, already codec-decoded); the raw snake_case Postgres row shapes stay private to the
// repository module. Conventions: money is integer cents; bps is integer; timestamps are canonical
// ISO-8601 UTC strings; local times are "HH:MM[:SS]"; weekday sets are number[] (0=Sun..6=Sat).

export interface BookingProfile {
  hostUserId: string;
  displayHeadline: string | null;
  bio: string | null;
  topics: string[] | null;
  introVideoRef: string | null;
  hostTimezone: string;
  basePriceCents: number;
  defaultSlotDurationSeconds: number;
  platformFeeBps: number;
  payoutWalletAddress: string | null;
  isPublished: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AvailabilityRule {
  ruleId: string;
  hostUserId: string;
  byWeekday: number[];
  startLocal: string;
  endLocal: string;
  slotDurationSeconds: number;
  effectiveFromUtc: string | null;
  effectiveUntilUtc: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AvailabilityException {
  exceptionId: string;
  hostUserId: string;
  kind: "block" | "open";
  startUtc: string;
  endUtc: string;
  createdAt: string;
}

export interface PriceRule {
  priceRuleId: string;
  hostUserId: string;
  matchWeekday: number[] | null;
  matchLocalStart: string | null;
  matchLocalEnd: string | null;
  matchDurationSeconds: number | null;
  priceCents: number;
  priority: number;
  createdAt: string;
  updatedAt: string;
}

// Aggregate host configuration. `null` when the host has no profile row (the caller decides what an
// unpublished/absent profile means — the repository stays policy-free).
export interface HostConfiguration {
  profile: BookingProfile;
  availabilityRules: AvailabilityRule[];
  availabilityExceptions: AvailabilityException[];
  priceRules: PriceRule[];
}

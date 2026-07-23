import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  setBookingFeedDiscoveryInvalidatorForTests,
  setBookingHostConfigRepositoriesForTests,
  upsertBookingProfile,
} from "./host-authoring-service"

// Regression: platform_fee_bps is a platform-controlled commission and must NOT be
// settable by a host via self-service profile writes (mass-assignment → revenue loss).

let createdInput: { platformFeeBps?: number; hostUserId?: string } | null = null
let updatedInput: { platformFeeBps?: number } | null = null
let existingProfile: unknown = null
let invalidatedHosts: string[] = []

const fakeReadRepo = {
  getProfile: async () => existingProfile,
}
const fakeWriteRepo = {
  createProfile: async (input: { hostUserId: string; platformFeeBps: number }) => {
    createdInput = input
    return { ...input }
  },
  updateProfile: async (hostUserId: string, input: { platformFeeBps?: number }) => {
    updatedInput = input
    return { hostUserId, ...(existingProfile as object), ...input }
  },
}

const validProfile = {
  host_timezone: "UTC",
  base_price_cents: 5000,
  default_slot_duration_seconds: 1800,
  display_headline: "Lessons",
  bio: "hello",
}

describe("host booking profile — platform_fee_bps is not host-settable", () => {
  beforeEach(() => {
    createdInput = null
    updatedInput = null
    existingProfile = null
    invalidatedHosts = []
    setBookingHostConfigRepositoriesForTests({
      read: fakeReadRepo as never,
      write: fakeWriteRepo as never,
    })
    setBookingFeedDiscoveryInvalidatorForTests(async (hostUserId) => {
      invalidatedHosts.push(hostUserId)
    })
  })

  afterEach(() => {
    setBookingFeedDiscoveryInvalidatorForTests(null)
    setBookingHostConfigRepositoriesForTests(null)
  })

  test("create ignores a host-supplied platform_fee_bps and uses the platform default (1000)", async () => {
    const res = await upsertBookingProfile({} as never, "host_1", {
      ...validProfile,
      platform_fee_bps: 0, // attacker attempts to zero the platform commission
    } as never)
    expect(res.ok).toBe(true)
    expect(createdInput).not.toBeNull()
    expect(createdInput?.platformFeeBps).toBe(1000)
    expect(invalidatedHosts).toEqual(["host_1"])
  })

  test("update never writes a host-supplied platform_fee_bps", async () => {
    existingProfile = {
      hostUserId: "host_1",
      platformFeeBps: 1000,
      basePriceCents: 5000,
      defaultSlotDurationSeconds: 1800,
      hostTimezone: "UTC",
      isPublished: false,
    }
    const res = await upsertBookingProfile({} as never, "host_1", {
      ...validProfile,
      platform_fee_bps: 0,
    } as never)
    expect(res.ok).toBe(true)
    expect(updatedInput).not.toBeNull()
    expect(updatedInput?.platformFeeBps).toBeUndefined()
    expect(invalidatedHosts).toEqual(["host_1"])
  })
})

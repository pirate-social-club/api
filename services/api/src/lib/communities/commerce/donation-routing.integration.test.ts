import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClient, type Client } from "@libsql/client"
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import type { Env } from "../../../types"
import { HttpError } from "../../errors"
import { buildLocalCommunityDbUrl, configureLocalCommunityDbClient, ensureCommunityDbSchema } from "../community-local-db"
import {
  setCommunityCommerceCharityPayoutExecutorForTests,
  type CharityPayoutExecutionInput,
} from "./charity-payout-service"
import { assertEndaomentPayoutConfigured, setEndaomentSubmittedDonationReconcilerForTests } from "./endaoment-payout-service"
import { setCommunityCommerceBuyerFundingVerifierForTests } from "./funding-proof-service"
import { createCommunityPurchaseQuote } from "./quote-service"
import { reconcileStaleCommunityPurchaseSettlements, settleCommunityPurchase } from "./settlement-service"

const COMMUNITY_ID = "cmt_donation_routing"
const NOW = "2026-07-07T00:00:00.000Z"
const BUYER_WALLET = "0x0000000000000000000000000000000000000002"
const PAYOUT_DESTINATION = "0x00000000000000000000000000000000000000aa"

type PartnerStatus = "active" | "paused"

let consoleInfoSpy: any = null
let consoleWarnSpy: any = null

beforeEach(() => {
  consoleInfoSpy = spyOn(console, "info").mockImplementation(() => undefined)
  consoleWarnSpy = spyOn(console, "warn").mockImplementation(() => undefined)
})

afterEach(() => {
  consoleInfoSpy?.mockRestore()
  consoleWarnSpy?.mockRestore()
  consoleInfoSpy = null
  consoleWarnSpy = null
  setCommunityCommerceBuyerFundingVerifierForTests(null)
  setCommunityCommerceCharityPayoutExecutorForTests(null)
  setEndaomentSubmittedDonationReconcilerForTests(null)
})

async function createFixture(options: {
  partnerStatus?: PartnerStatus
  payoutDestinationRef?: string | null
} = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), "donation-routing-"))
  const controlPlaneUrl = buildLocalCommunityDbUrl(rootDir, "control_plane")
  const controlPlaneClient = createClient({ url: controlPlaneUrl })
  await configureLocalCommunityDbClient(controlPlaneClient)
  await seedControlPlanePolicies(controlPlaneClient)
  controlPlaneClient.close()

  const env = {
    ENVIRONMENT: "test",
    LOCAL_COMMUNITY_DB_ROOT: rootDir,
    CONTROL_PLANE_DATABASE_URL: controlPlaneUrl,
    PIRATE_CHECKOUT_OPERATOR_ADDRESS: "0x0000000000000000000000000000000000000001",
    ENDAOMENT_PAYOUT_PRIVATE_KEY: "0x0000000000000000000000000000000000000000000000000000000000000001",
    BASE_SEPOLIA_RPC_URL: "http://127.0.0.1:8545",
    ENDAOMENT_REGISTRY_ADDRESS: "0x00000000000000000000000000000000000000bb",
  } as Env
  const communityUrl = buildLocalCommunityDbUrl(rootDir, COMMUNITY_ID)
  const client = createClient({ url: communityUrl })
  await configureLocalCommunityDbClient(client)
  await ensureCommunityDbSchema(client)
  await seedCommunityRows(client, {
    partnerStatus: options.partnerStatus ?? "active",
    payoutDestinationRef: options.payoutDestinationRef ?? PAYOUT_DESTINATION,
  })
  client.close()

  const communityRepository = {
    getPrimaryCommunityDatabaseBinding: async () => null,
    getCommunityById: async () => null,
    getCommunityByRouteSlug: async () => null,
    getCommunityByNamespaceVerificationId: async () => null,
    listActiveCommunities: async () => [],
    searchActiveCommunities: async () => [],
    getCommunityPostProjectionByPostId: async () => null,
    recordCommunityPostProjection: async () => {
      throw new Error("recordCommunityPostProjection is not used by donation routing tests")
    },
    updateCommunityPostProjectionStatus: async () => undefined,
    updateCommunityPostProjectionPayload: async () => undefined,
    updateCommunityPostProjectionMetrics: async () => undefined,
  } as Parameters<typeof createCommunityPurchaseQuote>[0]["communityRepository"]
  const userRepository = {
    getUserById: async () => ({ id: "usr_buyer" }),
    getWalletAttachmentsByUserId: async () => [{
      wallet_attachment: "wa_buyer",
      wallet_address: BUYER_WALLET,
      status: "active",
    }],
  } as unknown as Parameters<typeof createCommunityPurchaseQuote>[0]["userRepository"]

  return { rootDir, env, communityRepository, userRepository }
}

async function seedControlPlanePolicies(client: Client): Promise<void> {
  await client.execute(`
    CREATE TABLE community_money_policies (
      community_id TEXT PRIMARY KEY,
      funding_preference TEXT NOT NULL,
      accepted_funding_assets_json TEXT NOT NULL,
      accepted_source_chains_json TEXT NOT NULL,
      approved_route_providers_json TEXT,
      destination_settlement_chain_json TEXT NOT NULL,
      destination_settlement_token TEXT NOT NULL,
      treasury_denomination TEXT,
      max_slippage_bps INTEGER NOT NULL,
      quote_ttl_seconds INTEGER NOT NULL,
      route_required INTEGER NOT NULL,
      route_status_policy TEXT NOT NULL,
      route_hop_tolerance INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  await client.execute(`
    CREATE TABLE community_pricing_policies (
      community_id TEXT PRIMARY KEY,
      regional_pricing_enabled INTEGER NOT NULL,
      verification_provider_requirement TEXT,
      default_tier_key TEXT,
      tiers_json TEXT NOT NULL,
      country_assignments_json TEXT NOT NULL,
      source_template_id TEXT,
      source_template_version TEXT,
      pricing_policy_version TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
}

async function seedCommunityRows(client: Client, options: {
  partnerStatus: PartnerStatus
  payoutDestinationRef: string | null
}): Promise<void> {
  await client.execute({
    sql: `
      INSERT INTO communities (
        community_id, display_name, description, status, artist_identity_id,
        artist_governance_state, membership_mode, default_age_gate_policy, allow_anonymous_identity,
        anonymous_identity_scope, donation_partner_id, donation_policy_mode, donation_partner_status,
        governance_mode, settings_json, created_by_user_id, created_at, updated_at
      ) VALUES (
        ?1, 'Donation Routing', NULL, 'active', NULL,
        'fan_run', 'open', 'none', 0,
        NULL, 'dnp_live', 'optional_creator_sidecar', 'active',
        'centralized', NULL, 'usr_host', ?2, ?2
      )
    `,
    args: [COMMUNITY_ID, NOW],
  })
  await client.execute({
    sql: `
      INSERT INTO community_memberships (
        membership_id, community_id, user_id, status, joined_at, created_at, updated_at
      ) VALUES
        ('mem_host', ?1, 'usr_host', 'member', ?2, ?2, ?2),
        ('mem_buyer', ?1, 'usr_buyer', 'member', ?2, ?2, ?2)
    `,
    args: [COMMUNITY_ID, NOW],
  })
  await client.execute({
    sql: `
      INSERT INTO donation_partners (
        donation_partner_id, display_name, provider, provider_partner_ref, image_url,
        review_status, status, created_at, updated_at, payout_destination_ref
      ) VALUES (
        'dnp_live', 'Live Charity', 'endaoment', 'endaoment_entity', NULL,
        'approved', ?1, ?2, ?2, ?3
      )
    `,
    args: [options.partnerStatus, NOW, options.payoutDestinationRef],
  })
  await client.execute({
    sql: `
      INSERT INTO posts (
        post_id, community_id, author_user_id, identity_mode, post_type, status,
        title, analysis_state, content_safety_state, age_gate_policy, created_at, updated_at
      ) VALUES (
        'pst_live_donation', ?1, 'usr_host', 'public', 'video', 'published',
        'Live donation', 'allow', 'safe', 'none', ?2, ?2
      )
    `,
    args: [COMMUNITY_ID, NOW],
  })
  await client.execute({
    sql: `
      INSERT INTO live_rooms (
        live_room_id, community_id, anchor_post_id, host_user_id, guest_user_id,
        room_kind, status, access_mode, visibility, title, description, cover_ref,
        event_start_at, live_started_at, ended_at, canceled_at, broadcast_ref,
        replay_status, created_at, updated_at, store_url, store_label, recording_enabled,
        replay_asset_id, replay_listing_id, audience_gate_json
      ) VALUES (
        'lr_live_donation', ?1, 'pst_live_donation', 'usr_host', NULL,
        'solo', 'live', 'paid', 'public', 'Live donation', NULL, NULL,
        NULL, ?2, NULL, NULL, NULL,
        'none', ?3, ?3, NULL, NULL, 0,
        NULL, NULL, NULL
      )
    `,
    args: [COMMUNITY_ID, Math.floor(Date.parse(NOW) / 1000), NOW],
  })
  await client.execute({
    sql: `
      INSERT INTO listings (
        listing_id, community_id, asset_id, live_room_id, replay_asset_id, listing_mode,
        status, price_usd, regional_pricing_policy_json, vinyl_release_provider,
        vinyl_release_url, created_by_user_id, created_at, updated_at
      ) VALUES (
        'lst_live_donation', ?1, NULL, 'lr_live_donation', NULL, 'fixed_price',
        'active', 10, ?2, NULL,
        NULL, 'usr_host', ?3, ?3
      )
    `,
    args: [
      COMMUNITY_ID,
      JSON.stringify({ donation_partner_id: "dnp_live", donation_share_pct: 10 }),
      NOW,
    ],
  })
  await client.execute({
    sql: `
      INSERT INTO live_room_recordings (
        recording_id, community_id, live_room_id, provider, provider_resource_id,
        provider_session_id, status, started_at, stopped_at, raw_artifact_ref,
        failure_reason, created_at, updated_at
      ) VALUES (
        'rec_live_donation', ?1, 'lr_live_donation', 'agora', NULL,
        NULL, 'captured', ?2, ?2, 'r2://recording',
        NULL, ?3, ?3
      )
    `,
    args: [COMMUNITY_ID, Math.floor(Date.parse(NOW) / 1000), NOW],
  })
  await client.execute({
    sql: `
      INSERT INTO live_room_replay_assets (
        replay_asset_id, community_id, live_room_id, source_recording_id,
        publication_status, title, caption, duration_ms, preview_ref, access_mode,
        primary_content_ref, locked_delivery_status, locked_delivery_storage_ref,
        story_cdr_vault_uuid, published_at, created_at, updated_at
      ) VALUES (
        'lrp_live_donation', ?1, 'lr_live_donation', 'rec_live_donation',
        'published', 'Live donation replay', NULL, 60000, NULL, 'paid',
        'r2://replay', 'ready', 'r2://locked-replay',
        'vault-replay', ?2, ?2, ?2
      )
    `,
    args: [COMMUNITY_ID, NOW],
  })
  await client.execute({
    sql: `
      INSERT INTO live_room_replay_allocations (
        allocation_id, replay_asset_id, community_id, participant_user_id,
        external_party_ref, role, share_bps, rights_basis, approval_status,
        created_at, updated_at
      ) VALUES (
        'lra_replay_host', 'lrp_live_donation', ?1, 'usr_host',
        NULL, 'host', 10000, 'performer_default', 'approved',
        ?2, ?2
      )
    `,
    args: [COMMUNITY_ID, NOW],
  })
  await client.execute({
    sql: `
      INSERT INTO listings (
        listing_id, community_id, asset_id, live_room_id, replay_asset_id, listing_mode,
        status, price_usd, regional_pricing_policy_json, vinyl_release_provider,
        vinyl_release_url, created_by_user_id, created_at, updated_at
      ) VALUES (
        'lst_replay_donation', ?1, NULL, NULL, 'lrp_live_donation', 'fixed_price',
        'active', 10, ?2, NULL,
        NULL, 'usr_host', ?3, ?3
      )
    `,
    args: [
      COMMUNITY_ID,
      JSON.stringify({ donation_partner_id: "dnp_live", donation_share_pct: 10 }),
      NOW,
    ],
  })
}

function quoteBody(listing = "lst_lst_live_donation") {
  return {
    listing,
    funding_asset: {
      asset_symbol: "USDC",
      chain_namespace: "eip155",
      chain_id: 84532,
      display_name: "USDC on Base Sepolia",
    },
    source_chain: {
      chain_namespace: "eip155",
      chain_id: 84532,
      display_name: "Base Sepolia",
    },
    route_provider: "pirate_checkout",
    client_estimated_slippage_bps: 0,
    client_estimated_hop_count: 0,
    client_route_valid_for_seconds: 60,
  } as const
}

describe("live/replay donation routing", () => {
  test("live ticket donation quote settles the charity payout effect before local finalization", async () => {
    const fixture = await createFixture()
    const payoutCalls: CharityPayoutExecutionInput[] = []
    setCommunityCommerceBuyerFundingVerifierForTests(async ({ fundingTxRef }) => ({
      txRef: fundingTxRef,
      fromAddress: BUYER_WALLET,
      toAddress: "0x0000000000000000000000000000000000000001",
      tokenAddress: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
      amountAtomic: "10000000",
      chainRef: "eip155:84532",
    }))
    setCommunityCommerceCharityPayoutExecutorForTests(async (input) => {
      payoutCalls.push(input)
      return {
        settlementRef: "0xcharity",
        providerReceiptRef: "endaoment:receipt",
        taxReceiptRef: "endaoment:tax",
      }
    })

    const quote = await createCommunityPurchaseQuote({
      env: fixture.env,
      userId: "usr_buyer",
      communityId: COMMUNITY_ID,
      body: quoteBody(),
      communityRepository: fixture.communityRepository,
      userRepository: fixture.userRepository,
    })
    expect(quote.live_room).toBe("lr_live_donation")
    expect(quote.allocation_snapshot).toContainEqual(expect.objectContaining({
      recipient_type: "charity",
      recipient_ref: "dnp_live",
      amount_cents: 100,
      settlement_strategy: "provider_payout",
    }))

    const settlement = await settleCommunityPurchase({
      env: fixture.env,
      userId: "usr_buyer",
      communityId: COMMUNITY_ID,
      body: {
        quote: quote.id,
        settlement_wallet_attachment: "wa_buyer",
        funding_tx_ref: "0xfunding",
        settlement_tx_ref: "0xfunding",
      },
      communityRepository: fixture.communityRepository,
      userRepository: fixture.userRepository,
    })

    expect(payoutCalls).toHaveLength(1)
    expect(payoutCalls[0]).toMatchObject({
      donationPartnerId: "dnp_live",
      payoutDestinationRef: PAYOUT_DESTINATION,
      amountUsd: 1,
      amountAtomic: "1000000000000000000",
      settlementToken: "WIP",
    })
    expect(settlement.settlement.live_room).toBe("lr_live_donation")

    const client = createClient({ url: buildLocalCommunityDbUrl(fixture.rootDir, COMMUNITY_ID) })
    try {
      const effect = await client.execute({
        sql: `
          SELECT effect_kind, status, settlement_ref, provider_receipt_ref, tax_receipt_ref
          FROM purchase_settlement_effects
          WHERE community_id = ?1 AND effect_kind = 'charity_payout'
          LIMIT 1
        `,
        args: [COMMUNITY_ID],
      })
      expect(effect.rows[0]).toMatchObject({
        effect_kind: "charity_payout",
        status: "confirmed",
        settlement_ref: "0xcharity",
        provider_receipt_ref: "endaoment:receipt",
        tax_receipt_ref: "endaoment:tax",
      })

      const allocation = await client.execute({
        sql: `
          SELECT recipient_type, recipient_ref, amount_usd, status, settlement_ref, provider_receipt_ref, tax_receipt_ref
          FROM purchase_allocation_legs
          WHERE community_id = ?1 AND recipient_type = 'charity'
          LIMIT 1
        `,
        args: [COMMUNITY_ID],
      })
      expect(allocation.rows[0]).toMatchObject({
        recipient_type: "charity",
        recipient_ref: "dnp_live",
        amount_usd: 1,
        status: "confirmed",
        settlement_ref: "0xcharity",
        provider_receipt_ref: "endaoment:receipt",
        tax_receipt_ref: "endaoment:tax",
      })

      const purchase = await client.execute({
        sql: `
          SELECT live_room_id, donation_partner_id, donation_share_pct, donation_amount_usd, donation_settlement_ref
          FROM purchases
          WHERE community_id = ?1
          LIMIT 1
        `,
        args: [COMMUNITY_ID],
      })
      expect(purchase.rows[0]).toMatchObject({
        live_room_id: "lr_live_donation",
        donation_partner_id: "dnp_live",
        donation_share_pct: 10,
        donation_amount_usd: 1,
        donation_settlement_ref: "0xcharity",
      })
    } finally {
      client.close()
    }

    const retry = await settleCommunityPurchase({
      env: fixture.env,
      userId: "usr_buyer",
      communityId: COMMUNITY_ID,
      body: {
        quote: quote.id,
        settlement_wallet_attachment: "wa_buyer",
        funding_tx_ref: "0xfunding",
        settlement_tx_ref: "0xfunding",
      },
      communityRepository: fixture.communityRepository,
      userRepository: fixture.userRepository,
    })
    expect(retry.settlement.live_room).toBe("lr_live_donation")
    expect(payoutCalls).toHaveLength(1)
  })

  test("live ticket donation quote still rejects an inactive donation partner", async () => {
    const fixture = await createFixture({ partnerStatus: "paused" })

    await expect(createCommunityPurchaseQuote({
      env: fixture.env,
      userId: "usr_buyer",
      communityId: COMMUNITY_ID,
      body: quoteBody(),
      communityRepository: fixture.communityRepository,
      userRepository: fixture.userRepository,
    })).rejects.toThrow("Donation partner is not available")
  })

  test("charity payout failure does not finalize local purchase rows", async () => {
    const fixture = await createFixture()
    setCommunityCommerceBuyerFundingVerifierForTests(async ({ fundingTxRef }) => ({
      txRef: fundingTxRef,
      fromAddress: BUYER_WALLET,
      toAddress: "0x0000000000000000000000000000000000000001",
      tokenAddress: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
      amountAtomic: "10000000",
      chainRef: "eip155:84532",
    }))
    setCommunityCommerceCharityPayoutExecutorForTests(async () => {
      throw new Error("test charity payout failure")
    })

    const quote = await createCommunityPurchaseQuote({
      env: fixture.env,
      userId: "usr_buyer",
      communityId: COMMUNITY_ID,
      body: quoteBody(),
      communityRepository: fixture.communityRepository,
      userRepository: fixture.userRepository,
    })

    await expect(settleCommunityPurchase({
      env: fixture.env,
      userId: "usr_buyer",
      communityId: COMMUNITY_ID,
      body: {
        quote: quote.id,
        settlement_wallet_attachment: "wa_buyer",
        funding_tx_ref: "0xfunding_failed",
        settlement_tx_ref: "0xfunding_failed",
      },
      communityRepository: fixture.communityRepository,
      userRepository: fixture.userRepository,
    })).rejects.toThrow("test charity payout failure")

    const client = createClient({ url: buildLocalCommunityDbUrl(fixture.rootDir, COMMUNITY_ID) })
    try {
      const purchaseCount = await client.execute({
        sql: "SELECT COUNT(*) AS count FROM purchases WHERE community_id = ?1",
        args: [COMMUNITY_ID],
      })
      expect(Number(purchaseCount.rows[0]?.count ?? 0)).toBe(0)

      const entitlementCount = await client.execute({
        sql: "SELECT COUNT(*) AS count FROM purchase_entitlements WHERE community_id = ?1",
        args: [COMMUNITY_ID],
      })
      expect(Number(entitlementCount.rows[0]?.count ?? 0)).toBe(0)

      const effect = await client.execute({
        sql: `
          SELECT effect_kind, status, settlement_ref, failure_reason
          FROM purchase_settlement_effects
          WHERE community_id = ?1 AND effect_kind = 'charity_payout'
          LIMIT 1
        `,
        args: [COMMUNITY_ID],
      })
      expect(effect.rows[0]).toMatchObject({
        effect_kind: "charity_payout",
        status: "failed",
        settlement_ref: null,
        failure_reason: "test charity payout failure",
      })

      const attempt = await client.execute({
        sql: `
          SELECT status, failure_reason
          FROM purchase_settlement_attempts
          WHERE community_id = ?1
          LIMIT 1
        `,
        args: [COMMUNITY_ID],
      })
      expect(attempt.rows[0]).toMatchObject({
        status: "failed",
        failure_reason: "test charity payout failure",
      })
    } finally {
      client.close()
    }
  })

  test("charity payout 409 leaves the settlement attempt in progress", async () => {
    const fixture = await createFixture()
    setCommunityCommerceBuyerFundingVerifierForTests(async ({ fundingTxRef }) => ({
      txRef: fundingTxRef,
      fromAddress: BUYER_WALLET,
      toAddress: "0x0000000000000000000000000000000000000001",
      tokenAddress: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
      amountAtomic: "10000000",
      chainRef: "eip155:84532",
    }))
    setCommunityCommerceCharityPayoutExecutorForTests(async () => {
      throw new HttpError(409, "conflict", "Purchase settlement effect is already in progress")
    })

    const quote = await createCommunityPurchaseQuote({
      env: fixture.env,
      userId: "usr_buyer",
      communityId: COMMUNITY_ID,
      body: quoteBody(),
      communityRepository: fixture.communityRepository,
      userRepository: fixture.userRepository,
    })

    await expect(settleCommunityPurchase({
      env: fixture.env,
      userId: "usr_buyer",
      communityId: COMMUNITY_ID,
      body: {
        quote: quote.id,
        settlement_wallet_attachment: "wa_buyer",
        funding_tx_ref: "0xfunding_conflict",
        settlement_tx_ref: "0xfunding_conflict",
      },
      communityRepository: fixture.communityRepository,
      userRepository: fixture.userRepository,
    })).rejects.toThrow("Purchase settlement effect is already in progress")

    const client = createClient({ url: buildLocalCommunityDbUrl(fixture.rootDir, COMMUNITY_ID) })
    try {
      const effect = await client.execute({
        sql: `
          SELECT effect_kind, status, settlement_ref, failure_reason
          FROM purchase_settlement_effects
          WHERE community_id = ?1 AND effect_kind = 'charity_payout'
          LIMIT 1
        `,
        args: [COMMUNITY_ID],
      })
      expect(effect.rows[0]).toMatchObject({
        effect_kind: "charity_payout",
        status: "submitted",
        settlement_ref: null,
        failure_reason: null,
      })

      const attempt = await client.execute({
        sql: `
          SELECT status, failure_reason
          FROM purchase_settlement_attempts
          WHERE community_id = ?1
          LIMIT 1
        `,
        args: [COMMUNITY_ID],
      })
      expect(attempt.rows[0]).toMatchObject({
        status: "attempting",
        failure_reason: null,
      })

      const purchaseCount = await client.execute({
        sql: "SELECT COUNT(*) AS count FROM purchases WHERE community_id = ?1",
        args: [COMMUNITY_ID],
      })
      expect(Number(purchaseCount.rows[0]?.count ?? 0)).toBe(0)
    } finally {
      client.close()
    }
  })

  test("stale submitted charity payout with tx hash is reconciled without re-executing payout", async () => {
    const fixture = await createFixture()
    const payoutCalls: CharityPayoutExecutionInput[] = []
    setCommunityCommerceBuyerFundingVerifierForTests(async ({ fundingTxRef }) => ({
      txRef: fundingTxRef,
      fromAddress: BUYER_WALLET,
      toAddress: "0x0000000000000000000000000000000000000001",
      tokenAddress: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
      amountAtomic: "10000000",
      chainRef: "eip155:84532",
    }))
    setCommunityCommerceCharityPayoutExecutorForTests(async (input) => {
      payoutCalls.push(input)
      await input.recordSubmittedTxHash?.({
        txHash: "0xsubmittedcharity",
        providerReceiptRef: "endaoment:84532:entity:0xsubmittedcharity",
        metadata: {
          provider: "endaoment",
          chain_id: 84532,
          entity_address: PAYOUT_DESTINATION,
        },
      })
      throw new HttpError(409, "conflict", "Endaoment donation confirmation is pending")
    })
    setEndaomentSubmittedDonationReconcilerForTests(async ({ txHash, metadata }) => {
      expect(txHash).toBe("0xsubmittedcharity")
      expect(metadata.provider).toBe("endaoment")
      return {
        status: "confirmed",
        settlementRef: txHash,
        providerReceiptRef: "endaoment:84532:entity:0xsubmittedcharity",
      }
    })

    const quote = await createCommunityPurchaseQuote({
      env: fixture.env,
      userId: "usr_buyer",
      communityId: COMMUNITY_ID,
      body: quoteBody(),
      communityRepository: fixture.communityRepository,
      userRepository: fixture.userRepository,
    })

    await expect(settleCommunityPurchase({
      env: fixture.env,
      userId: "usr_buyer",
      communityId: COMMUNITY_ID,
      body: {
        quote: quote.id,
        settlement_wallet_attachment: "wa_buyer",
        funding_tx_ref: "0xfunding_submitted_reconcile",
        settlement_tx_ref: "0xfunding_submitted_reconcile",
      },
      communityRepository: fixture.communityRepository,
      userRepository: fixture.userRepository,
    })).rejects.toThrow("Endaoment donation confirmation is pending")

    const beforeClient = createClient({ url: buildLocalCommunityDbUrl(fixture.rootDir, COMMUNITY_ID) })
    try {
      const effect = await beforeClient.execute({
        sql: `
          SELECT status, settlement_ref, provider_receipt_ref
          FROM purchase_settlement_effects
          WHERE community_id = ?1 AND effect_kind = 'charity_payout'
          LIMIT 1
        `,
        args: [COMMUNITY_ID],
      })
      expect(effect.rows[0]).toMatchObject({
        status: "submitted",
        settlement_ref: "0xsubmittedcharity",
        provider_receipt_ref: "endaoment:84532:entity:0xsubmittedcharity",
      })
    } finally {
      beforeClient.close()
    }

    const summary = await reconcileStaleCommunityPurchaseSettlements({
      env: fixture.env,
      communityRepository: {
        ...fixture.communityRepository,
        listActiveCommunities: async () => [{ community_id: COMMUNITY_ID }],
      } as Parameters<typeof reconcileStaleCommunityPurchaseSettlements>[0]["communityRepository"],
      staleMs: 0,
    })
    expect(summary).toMatchObject({
      checked: 1,
      finalized: 1,
      failed: 0,
      stillPending: 0,
      errors: 0,
    })
    expect(payoutCalls).toHaveLength(1)

    const client = createClient({ url: buildLocalCommunityDbUrl(fixture.rootDir, COMMUNITY_ID) })
    try {
      const effect = await client.execute({
        sql: `
          SELECT status, settlement_ref, provider_receipt_ref
          FROM purchase_settlement_effects
          WHERE community_id = ?1 AND effect_kind = 'charity_payout'
          LIMIT 1
        `,
        args: [COMMUNITY_ID],
      })
      expect(effect.rows[0]).toMatchObject({
        status: "confirmed",
        settlement_ref: "0xsubmittedcharity",
        provider_receipt_ref: "endaoment:84532:entity:0xsubmittedcharity",
      })

      const purchase = await client.execute({
        sql: `
          SELECT live_room_id, donation_settlement_ref
          FROM purchases
          WHERE community_id = ?1
          LIMIT 1
        `,
        args: [COMMUNITY_ID],
      })
      expect(purchase.rows[0]).toMatchObject({
        live_room_id: "lr_live_donation",
        donation_settlement_ref: "0xsubmittedcharity",
      })
    } finally {
      client.close()
    }
  })

  test("pending submitted charity payout emits stale metric without re-executing payout", async () => {
    const fixture = await createFixture()
    fixture.env.ENDAOMENT_SUBMITTED_STALE_ALERT_MS = "0"
    const payoutCalls: CharityPayoutExecutionInput[] = []
    setCommunityCommerceBuyerFundingVerifierForTests(async ({ fundingTxRef }) => ({
      txRef: fundingTxRef,
      fromAddress: BUYER_WALLET,
      toAddress: "0x0000000000000000000000000000000000000001",
      tokenAddress: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
      amountAtomic: "10000000",
      chainRef: "eip155:84532",
    }))
    setCommunityCommerceCharityPayoutExecutorForTests(async (input) => {
      payoutCalls.push(input)
      await input.recordSubmittedTxHash?.({
        txHash: "0xpendingcharity",
        providerReceiptRef: "endaoment:84532:entity:0xpendingcharity",
        metadata: {
          provider: "endaoment",
          chain_id: 84532,
          entity_address: PAYOUT_DESTINATION,
        },
      })
      throw new HttpError(409, "conflict", "Endaoment donation confirmation is pending")
    })
    setEndaomentSubmittedDonationReconcilerForTests(async ({ txHash }) => {
      expect(txHash).toBe("0xpendingcharity")
      return { status: "pending" }
    })

    const quote = await createCommunityPurchaseQuote({
      env: fixture.env,
      userId: "usr_buyer",
      communityId: COMMUNITY_ID,
      body: quoteBody(),
      communityRepository: fixture.communityRepository,
      userRepository: fixture.userRepository,
    })

    await expect(settleCommunityPurchase({
      env: fixture.env,
      userId: "usr_buyer",
      communityId: COMMUNITY_ID,
      body: {
        quote: quote.id,
        settlement_wallet_attachment: "wa_buyer",
        funding_tx_ref: "0xfunding_submitted_pending",
        settlement_tx_ref: "0xfunding_submitted_pending",
      },
      communityRepository: fixture.communityRepository,
      userRepository: fixture.userRepository,
    })).rejects.toThrow("Endaoment donation confirmation is pending")

    const summary = await reconcileStaleCommunityPurchaseSettlements({
      env: fixture.env,
      communityRepository: {
        ...fixture.communityRepository,
        listActiveCommunities: async () => [{ community_id: COMMUNITY_ID }],
      } as Parameters<typeof reconcileStaleCommunityPurchaseSettlements>[0]["communityRepository"],
      staleMs: 0,
    })
    expect(summary).toMatchObject({
      checked: 1,
      finalized: 0,
      failed: 0,
      stillPending: 1,
      errors: 0,
    })
    expect(payoutCalls).toHaveLength(1)
    const staleMetric = consoleWarnSpy.mock.calls
      .map((call: unknown[]) => typeof call[0] === "string" ? call[0] : "")
      .find((line: string) => line.includes("\"metric\":\"charity_payout_submitted_stale\""))
    expect(staleMetric).toBeTruthy()
    const parsed = JSON.parse(staleMetric || "{}")
    expect(parsed).toMatchObject({
      metric: "charity_payout_submitted_stale",
      community_id: COMMUNITY_ID,
      quote_id: quote.id.replace(/^pq_/u, ""),
      donation_partner_id: "dnp_live",
      reason: "receipt_pending",
    })
    expect(String(parsed.allocation_key || "")).toStartWith("charity:dnp_live:")
    expect(String(parsed.purchase_id || "")).toBeTruthy()
    expect(typeof parsed.age_seconds).toBe("number")
  })

  test("consumed charity purchase with missing payout effect reports the payout inconsistency", async () => {
    const fixture = await createFixture()
    setCommunityCommerceBuyerFundingVerifierForTests(async ({ fundingTxRef }) => ({
      txRef: fundingTxRef,
      fromAddress: BUYER_WALLET,
      toAddress: "0x0000000000000000000000000000000000000001",
      tokenAddress: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
      amountAtomic: "10000000",
      chainRef: "eip155:84532",
    }))
    setCommunityCommerceCharityPayoutExecutorForTests(async () => ({
      settlementRef: "0xcharity-missing-later",
      providerReceiptRef: "endaoment:missing-later",
      taxReceiptRef: null,
    }))

    const quote = await createCommunityPurchaseQuote({
      env: fixture.env,
      userId: "usr_buyer",
      communityId: COMMUNITY_ID,
      body: quoteBody(),
      communityRepository: fixture.communityRepository,
      userRepository: fixture.userRepository,
    })
    await settleCommunityPurchase({
      env: fixture.env,
      userId: "usr_buyer",
      communityId: COMMUNITY_ID,
      body: {
        quote: quote.id,
        settlement_wallet_attachment: "wa_buyer",
        funding_tx_ref: "0xfunding_missing_later",
        settlement_tx_ref: "0xfunding_missing_later",
      },
      communityRepository: fixture.communityRepository,
      userRepository: fixture.userRepository,
    })

    const client = createClient({ url: buildLocalCommunityDbUrl(fixture.rootDir, COMMUNITY_ID) })
    try {
      await client.execute({
        sql: `
          UPDATE purchase_settlement_effects
          SET status = 'failed',
              settlement_ref = NULL,
              failure_reason = 'simulated missing charity confirmation'
          WHERE community_id = ?1 AND effect_kind = 'charity_payout'
        `,
        args: [COMMUNITY_ID],
      })
    } finally {
      client.close()
    }

    await expect(settleCommunityPurchase({
      env: fixture.env,
      userId: "usr_buyer",
      communityId: COMMUNITY_ID,
      body: {
        quote: quote.id,
        settlement_wallet_attachment: "wa_buyer",
        funding_tx_ref: "0xfunding_missing_later",
        settlement_tx_ref: "0xfunding_missing_later",
      },
      communityRepository: fixture.communityRepository,
      userRepository: fixture.userRepository,
    })).rejects.toThrow("Purchase settlement is missing confirmed charity payout")

    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining("charity_payout_missing_for_existing_settlement"))
  })

  test("paid replay donation quote settles the charity payout effect before local finalization", async () => {
    const fixture = await createFixture()
    const payoutCalls: CharityPayoutExecutionInput[] = []
    setCommunityCommerceBuyerFundingVerifierForTests(async ({ fundingTxRef }) => ({
      txRef: fundingTxRef,
      fromAddress: BUYER_WALLET,
      toAddress: "0x0000000000000000000000000000000000000001",
      tokenAddress: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
      amountAtomic: "10000000",
      chainRef: "eip155:84532",
    }))
    setCommunityCommerceCharityPayoutExecutorForTests(async (input) => {
      payoutCalls.push(input)
      return {
        settlementRef: "0xreplaycharity",
        providerReceiptRef: "endaoment:replay-receipt",
        taxReceiptRef: "endaoment:replay-tax",
      }
    })

    const quote = await createCommunityPurchaseQuote({
      env: fixture.env,
      userId: "usr_buyer",
      communityId: COMMUNITY_ID,
      body: quoteBody("lst_lst_replay_donation"),
      communityRepository: fixture.communityRepository,
      userRepository: fixture.userRepository,
    })
    expect(quote.replay_asset).toBe("lrp_live_donation")
    expect(quote.allocation_snapshot).toContainEqual(expect.objectContaining({
      recipient_type: "charity",
      recipient_ref: "dnp_live",
      amount_cents: 100,
      settlement_strategy: "provider_payout",
    }))

    const settlement = await settleCommunityPurchase({
      env: fixture.env,
      userId: "usr_buyer",
      communityId: COMMUNITY_ID,
      body: {
        quote: quote.id,
        settlement_wallet_attachment: "wa_buyer",
        funding_tx_ref: "0xreplayfunding",
        settlement_tx_ref: "0xreplayfunding",
      },
      communityRepository: fixture.communityRepository,
      userRepository: fixture.userRepository,
    })

    expect(payoutCalls).toHaveLength(1)
    expect(payoutCalls[0]).toMatchObject({
      donationPartnerId: "dnp_live",
      payoutDestinationRef: PAYOUT_DESTINATION,
      amountUsd: 1,
      amountAtomic: "1000000000000000000",
      settlementToken: "WIP",
    })
    expect(settlement.settlement.replay_asset).toBe("lrp_live_donation")

    const client = createClient({ url: buildLocalCommunityDbUrl(fixture.rootDir, COMMUNITY_ID) })
    try {
      const effect = await client.execute({
        sql: `
          SELECT effect_kind, status, settlement_ref, provider_receipt_ref, tax_receipt_ref
          FROM purchase_settlement_effects
          WHERE community_id = ?1 AND effect_kind = 'charity_payout'
          LIMIT 1
        `,
        args: [COMMUNITY_ID],
      })
      expect(effect.rows[0]).toMatchObject({
        effect_kind: "charity_payout",
        status: "confirmed",
        settlement_ref: "0xreplaycharity",
        provider_receipt_ref: "endaoment:replay-receipt",
        tax_receipt_ref: "endaoment:replay-tax",
      })

      const purchase = await client.execute({
        sql: `
          SELECT replay_asset_id, donation_partner_id, donation_share_pct, donation_amount_usd, donation_settlement_ref
          FROM purchases
          WHERE community_id = ?1
          LIMIT 1
        `,
        args: [COMMUNITY_ID],
      })
      expect(purchase.rows[0]).toMatchObject({
        replay_asset_id: "lrp_live_donation",
        donation_partner_id: "dnp_live",
        donation_share_pct: 10,
        donation_amount_usd: 1,
        donation_settlement_ref: "0xreplaycharity",
      })
    } finally {
      client.close()
    }
  })

  test("endaoment payout config does not require a registry address", () => {
    expect(() => assertEndaomentPayoutConfigured({
      ENDAOMENT_PAYOUT_PRIVATE_KEY: "0x0000000000000000000000000000000000000000000000000000000000000001",
      PIRATE_CHECKOUT_SOURCE_CHAIN_ID: "84532",
      PIRATE_CHECKOUT_RPC_URL: "http://127.0.0.1:8545",
      PIRATE_CHECKOUT_USDC_TOKEN_ADDRESS: "0x00000000000000000000000000000000000000cc",
    } as Env)).not.toThrow()
  })
})

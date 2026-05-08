import { afterEach, describe, expect, test } from "bun:test"
import { DatabaseIdentityRepository } from "../src/lib/auth/db-identity-repository"
import type { Client, InStatement, QueryResult, Transaction } from "../src/lib/sql-client"
import type { UpstreamIdentity } from "../src/types"
import { createControlPlaneTestClient } from "./helpers"

const WALLET_A = "0x1111111111111111111111111111111111111111"
const WALLET_B = "0x2222222222222222222222222222222222222222"

let cleanup: (() => Promise<void>) | null = null

afterEach(async () => {
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

class AuthProviderLinkRaceClient implements Client {
  constructor(private readonly client: Client) {}

  execute(statement: InStatement | string): Promise<QueryResult> {
    return this.client.execute(statement)
  }

  batch(statements: InStatement[], mode?: "read" | "write"): Promise<QueryResult[]> {
    return this.client.batch(statements, mode)
  }

  async transaction(mode?: "read" | "write"): Promise<Transaction> {
    const tx = await this.client.transaction(mode)
    return {
      execute: async (statement: InStatement | string): Promise<QueryResult> => {
        const sql = typeof statement === "string" ? statement : statement.sql
        if (sql.includes("FROM auth_provider_links")) {
          return { rows: [] }
        }
        if (sql.includes("INSERT INTO auth_provider_links")) {
          throw new Error('duplicate key value violates unique constraint "idx_auth_provider_links_active_subject"')
        }
        return tx.execute(statement)
      },
      batch: (statements: InStatement[], transactionMode?: "read" | "write"): Promise<QueryResult[]> =>
        tx.batch(statements, transactionMode),
      commit: (): Promise<void> => tx.commit(),
      rollback: (): Promise<void> => tx.rollback(),
      close: (): void => tx.close(),
    }
  }

  close(): void | Promise<void> {
    return this.client.close?.()
  }
}

describe("control-plane identity repository", () => {
  test("jwt identities create users with empty wallet attachments", async () => {
    const setup = await createControlPlaneTestClient({ includeAllMigrations: true })
    cleanup = setup.cleanup
    const repo = new DatabaseIdentityRepository(setup.client)

    const session = await repo.exchangeIdentity({
      provider: "jwt",
      providerSubject: "pirate-dev|jwt-user",
      providerUserRef: "jwt-user",
      walletAddresses: [],
      selectedWalletAddress: null,
    })

    expect(session.user.primary_wallet_attachment).toBeNull()
    expect(session.wallet_attachments).toEqual([])
  })

  test("privy identities persist wallet attachments and can switch the primary wallet", async () => {
    const setup = await createControlPlaneTestClient({ includeAllMigrations: true })
    cleanup = setup.cleanup
    const repo = new DatabaseIdentityRepository(setup.client)

    const first = await repo.exchangeIdentity({
      provider: "privy",
      providerSubject: "did:privy:alice",
      providerUserRef: "did:privy:alice",
      walletAddresses: [WALLET_A, WALLET_B],
      selectedWalletAddress: WALLET_A,
    })

    expect(first.wallet_attachments).toHaveLength(2)
    expect(first.wallet_attachments.find((attachment) => attachment.is_primary)?.wallet_address).toBe(WALLET_A)
    expect(first.user.primary_wallet_attachment).toBe(first.wallet_attachments.find((attachment) => attachment.is_primary)?.wallet_attachment)
    expect(first.profile.primary_wallet_address).toBe(WALLET_A)

    const second = await repo.exchangeIdentity({
      provider: "privy",
      providerSubject: "did:privy:alice",
      providerUserRef: "did:privy:alice",
      walletAddresses: [WALLET_A, WALLET_B],
      selectedWalletAddress: WALLET_B,
    })

    expect(second.user.id).toBe(first.user.id)
    expect(second.wallet_attachments).toHaveLength(2)
    expect(second.wallet_attachments.find((attachment) => attachment.is_primary)?.wallet_address).toBe(WALLET_B)
    expect(second.user.primary_wallet_attachment).toBe(second.wallet_attachments.find((attachment) => attachment.is_primary)?.wallet_attachment)
    expect(second.profile.primary_wallet_address).toBe(WALLET_B)
  })

  test("new provider subjects with an existing wallet resolve to the wallet owner", async () => {
    const setup = await createControlPlaneTestClient({ includeAllMigrations: true })
    cleanup = setup.cleanup
    const repo = new DatabaseIdentityRepository(setup.client)

    const first = await repo.exchangeIdentity({
      provider: "jwt",
      providerSubject: "pirate-dev|wallet-owner-a",
      providerUserRef: "wallet-owner-a",
      walletAddresses: [WALLET_A],
      selectedWalletAddress: WALLET_A,
    })

    const second = await repo.exchangeIdentity({
      provider: "jwt",
      providerSubject: "pirate-dev|wallet-owner-b",
      providerUserRef: "wallet-owner-b",
      walletAddresses: [WALLET_A],
      selectedWalletAddress: WALLET_A,
    })

    expect(second.user.id).toBe(first.user.id)
    expect(second.wallet_attachments).toHaveLength(1)
    expect(second.wallet_attachments[0]?.wallet_address).toBe(WALLET_A)

    const userCount = await setup.client.execute("SELECT COUNT(*) AS count FROM users")
    expect(Number(userCount.rows[0]?.count ?? 0)).toBe(1)

    const linkCount = await setup.client.execute({
      sql: `
        SELECT COUNT(*) AS count
        FROM auth_provider_links
        WHERE user_id = ?1
          AND status = 'active'
      `,
      args: [first.user.id.replace(/^usr_/, "")],
    })
    expect(Number(linkCount.rows[0]?.count ?? 0)).toBe(2)

    const now = new Date().toISOString()
    await setup.client.execute({
      sql: `
        INSERT INTO users (
          user_id, primary_wallet_attachment_id, verification_state, capability_provider,
          verification_capabilities_json, verified_at, current_verification_session_id, created_at, updated_at
        ) VALUES ('usr_duplicate_wallet_owner', NULL, 'unverified', NULL, '{}', NULL, NULL, ?1, ?1)
      `,
      args: [now],
    })
    await expect(setup.client.execute({
      sql: `
        INSERT INTO wallet_attachments (
          wallet_attachment_id, user_id, chain_namespace, wallet_address_normalized, wallet_address_display,
          source_provider, source_subject, attachment_kind, is_primary, status, attached_at, detached_at, created_at, updated_at
        ) VALUES (
          'wal_duplicate_active_address', 'usr_duplicate_wallet_owner', 'eip155:1', ?1, ?1,
          'jwt', 'pirate-dev|duplicate-wallet-owner', 'external', 1, 'active', ?2, NULL, ?2, ?2
        )
      `,
      args: [WALLET_A, now],
    })).rejects.toThrow()
  })

  test("recovers when a concurrent signup wins the active auth provider link insert", async () => {
    const setup = await createControlPlaneTestClient({ includeAllMigrations: true })
    cleanup = setup.cleanup
    const identity = {
      provider: "jwt",
      providerSubject: "pirate-dev|race-user",
      providerUserRef: "race-user",
      walletAddresses: [],
      selectedWalletAddress: null,
    } satisfies UpstreamIdentity
    const first = await new DatabaseIdentityRepository(setup.client).exchangeIdentity(identity)
    const second = await new DatabaseIdentityRepository(new AuthProviderLinkRaceClient(setup.client))
      .exchangeIdentity(identity)

    expect(second.user.id).toBe(first.user.id)
  })
})

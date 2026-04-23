import { makeId, nowIso } from "../src/lib/helpers"
import { getControlPlaneClient } from "../src/lib/runtime-deps"
import { buildDefaultVerificationCapabilities } from "../src/lib/verification/verification-capabilities"
import type { Env } from "../src/types"

function readFlag(name: string): string | null {
  const prefix = `${name}=`
  const raw = process.argv.slice(2).find((value) => value.startsWith(prefix))
  if (!raw) return null
  const value = raw.slice(prefix.length).trim()
  return value || null
}

async function main(): Promise<void> {
  const userId = readFlag("--user-id")
  const walletAddress = readFlag("--wallet-address")

  if (!userId) {
    throw new Error("--user-id is required")
  }
  if (!walletAddress) {
    throw new Error("--wallet-address is required")
  }

  const client = getControlPlaneClient(process.env as Env)
  const tx = await client.transaction("write")
  try {
    const now = nowIso()
    const normalizedAddress = walletAddress.toLowerCase()
    const userRow = await tx.execute({
      sql: `
        SELECT user_id
        FROM users
        WHERE user_id = ?1
        LIMIT 1
      `,
      args: [userId],
    })
    if (userRow.rows.length === 0) {
      await tx.execute({
        sql: `
          INSERT INTO users (
            user_id,
            primary_wallet_attachment_id,
            verification_state,
            capability_provider,
            verification_capabilities_json,
            verified_at,
            current_verification_session_id,
            created_at,
            updated_at
          ) VALUES (
            ?1,
            NULL,
            'unverified',
            NULL,
            ?2,
            NULL,
            NULL,
            ?3,
            ?3
          )
        `,
        args: [userId, JSON.stringify(buildDefaultVerificationCapabilities()), now],
      })
    }

    const existing = await tx.execute({
      sql: `
        SELECT wallet_attachment_id
        FROM wallet_attachments
        WHERE user_id = ?1
          AND status = 'active'
        ORDER BY is_primary DESC, attached_at DESC, created_at DESC
        LIMIT 1
      `,
      args: [userId],
    })
    const walletAttachmentId = String(existing.rows[0]?.wallet_attachment_id || makeId("wal"))

    if (existing.rows.length > 0) {
      await tx.execute({
        sql: `
          UPDATE wallet_attachments
          SET chain_namespace = 'eip155:1315',
              wallet_address_normalized = ?2,
              wallet_address_display = ?3,
              source_provider = 'jwt',
              source_subject = ?1,
              attachment_kind = 'external',
              is_primary = 1,
              status = 'active',
              detached_at = NULL,
              updated_at = ?4
          WHERE wallet_attachment_id = ?5
        `,
        args: [userId, normalizedAddress, walletAddress, now, walletAttachmentId],
      })
    } else {
      await tx.execute({
        sql: `
          INSERT INTO wallet_attachments (
            wallet_attachment_id,
            user_id,
            chain_namespace,
            wallet_address_normalized,
            wallet_address_display,
            source_provider,
            source_subject,
            attachment_kind,
            is_primary,
            status,
            attached_at,
            detached_at,
            created_at,
            updated_at
          ) VALUES (
            ?1,
            ?2,
            'eip155:1315',
            ?3,
            ?4,
            'jwt',
            ?2,
            'external',
            1,
            'active',
            ?5,
            NULL,
            ?5,
            ?5
          )
        `,
        args: [walletAttachmentId, userId, normalizedAddress, walletAddress, now],
      })
    }

    await tx.execute({
      sql: `
        UPDATE wallet_attachments
        SET is_primary = CASE WHEN wallet_attachment_id = ?2 THEN 1 ELSE 0 END,
            updated_at = ?3
        WHERE user_id = ?1
          AND status = 'active'
      `,
      args: [userId, walletAttachmentId, now],
    })

    await tx.execute({
      sql: `
        UPDATE users
        SET primary_wallet_attachment_id = ?2,
            updated_at = ?3
        WHERE user_id = ?1
      `,
      args: [userId, walletAttachmentId, now],
    })

    await tx.commit()
    console.log(walletAttachmentId)
  } catch (error) {
    try {
      await tx.rollback()
    } catch {}
    throw error
  } finally {
    tx.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

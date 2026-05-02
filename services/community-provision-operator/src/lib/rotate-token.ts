import { openControlPlaneDatabase } from "./control-plane-db";
import { encryptCommunityDbCredential } from "./credential-crypto";
import { TursoPlatformClient } from "./turso-platform";
import { makeId, nowIso, requireText, requirePositiveInt } from "./helpers";
import { getPrimaryBindingByCommunityId, getNextRotationNumber, writeActiveCommunityCredential } from "./queries";
import type {
  RotateCommunityTokenInput,
  RotateCommunityTokenResult,
  CommunityRow,
} from "./types";

export async function rotateCommunityToken(
  input: RotateCommunityTokenInput,
): Promise<RotateCommunityTokenResult> {
  const controlPlaneDatabaseUrl = requireText(input.controlPlaneDatabaseUrl, "controlPlaneDatabaseUrl");
  const controlPlaneAuthToken = input.controlPlaneAuthToken?.trim() || null;
  const tursoPlatformApiToken = requireText(input.tursoPlatformApiToken, "tursoPlatformApiToken");
  const tursoCommunityDbWrapKey = requireText(input.tursoCommunityDbWrapKey, "tursoCommunityDbWrapKey");
  const tursoCommunityDbWrapKeyVersion = requirePositiveInt(
    input.tursoCommunityDbWrapKeyVersion,
    "tursoCommunityDbWrapKeyVersion",
  );
  const communityId = requireText(input.communityId, "communityId");
  const timestamp = nowIso(input.now ?? new Date());
  const reason = input.reason?.trim() || null;
  const databaseTokenExpiration = input.databaseTokenExpiration?.trim() || null;
  const credentialId = makeId("cdc");
  const auditEventId = makeId("aud");
  const db = openControlPlaneDatabase({
    url: controlPlaneDatabaseUrl,
    authToken: controlPlaneAuthToken,
  });

  try {
    const communityRows = await db.sql<CommunityRow[]>`
      SELECT community_id, creator_user_id, primary_database_binding_id, provisioning_state, status, transfer_state
      FROM communities
      WHERE community_id = ${communityId}
      LIMIT 1
    `;
    const community = communityRows[0] ?? null;
    if (!community) {
      throw new Error(`community not found: ${communityId}`);
    }

    const binding = await getPrimaryBindingByCommunityId(db, communityId);
    if (!binding || binding.status !== "active") {
      throw new Error(`active primary community database binding not found: ${communityId}`);
    }

    const rotationNumber = await getNextRotationNumber(db, { communityId });
    const tokenName = `worker-${communityId}-v${rotationNumber}`;

    const platform = new TursoPlatformClient({
      apiToken: tursoPlatformApiToken,
      fetch: input.fetch,
    });
    const minted = await platform.createDatabaseAuthToken({
      organizationSlug: binding.organization_slug,
      databaseName: binding.database_name,
      expiration: databaseTokenExpiration ?? undefined,
      authorization: "full-access",
    });
    const plaintextToken = requireText(minted.jwt, "minted database auth token");
    const encryptedToken = await encryptCommunityDbCredential({
      plaintextToken,
      wrapKey: tursoCommunityDbWrapKey,
    });

    await db.begin(async (tx) => {
      await writeActiveCommunityCredential(tx, {
        communityDatabaseBindingId: binding.community_database_binding_id,
        communityDbCredentialId: credentialId,
        tokenName,
        encryptedToken,
        encryptionKeyVersion: tursoCommunityDbWrapKeyVersion,
        timestamp,
      });

      await tx.sql`
        UPDATE communities
        SET updated_at = ${timestamp}
        WHERE community_id = ${communityId}
      `;

      await tx.sql`
        INSERT INTO audit_log (
          audit_event_id,
          actor_type,
          actor_id,
          action,
          target_type,
          target_id,
          community_id,
          metadata_json,
          created_at
        ) VALUES (
          ${auditEventId},
          'system',
          NULL,
          'community.turso_token_rotated',
          'community',
          ${communityId},
          ${communityId},
          ${JSON.stringify({
            binding_id: binding.community_database_binding_id,
            credential_id: credentialId,
            token_name: tokenName,
            rotation_number: rotationNumber,
            reason,
          })},
          ${timestamp}
        )
      `;
    });

    return {
      communityId,
      communityDatabaseBindingId: binding.community_database_binding_id,
      communityDbCredentialId: credentialId,
      databaseName: binding.database_name,
      databaseUrl: binding.database_url,
      tokenName,
      rotationNumber,
    };
  } finally {
    await db.close();
  }
}

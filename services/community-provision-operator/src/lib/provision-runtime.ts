import { bootstrapCommunityDatabase } from "./community-bootstrap";
import { openControlPlaneDatabase } from "./control-plane-db";
import { TursoPlatformClient } from "./turso-platform";
import {
  buildCommunityDatabaseName,
  buildRegionPoolGroupName,
  nowIso,
  requireText,
  withProvisionStep,
} from "./helpers";
import {
  getNextRotationNumber,
  requireNamespaceVerification,
} from "./queries";
import type {
  ProvisionCommunityInput,
  ProvisionCommunityRuntimeResult,
} from "./types";

export async function provisionCommunityRuntime(
  input: ProvisionCommunityInput,
): Promise<ProvisionCommunityRuntimeResult> {
  const controlPlaneDatabaseUrl = requireText(input.controlPlaneDatabaseUrl, "controlPlaneDatabaseUrl");
  const controlPlaneAuthToken = input.controlPlaneAuthToken?.trim() || null;
  const tursoPlatformApiToken = requireText(input.tursoPlatformApiToken, "tursoPlatformApiToken");
  const tursoOrganizationSlug = requireText(input.tursoOrganizationSlug, "tursoOrganizationSlug");
  const communityId = requireText(input.communityId, "communityId");
  const creatorUserId = requireText(input.creatorUserId, "creatorUserId");
  const displayName = requireText(input.displayName, "displayName");
  const namespaceVerificationId = input.namespaceVerificationId?.trim() || null;
  const groupLocation = requireText(input.groupLocation, "groupLocation");
  const databaseTokenExpiration = input.databaseTokenExpiration?.trim() || null;
  const databaseName = buildCommunityDatabaseName(communityId);
  const groupName = buildRegionPoolGroupName(groupLocation);
  const bootstrapFn = input.bootstrapCommunityDatabaseFn ?? bootstrapCommunityDatabase;
  const timestamp = nowIso(input.now ?? new Date());
  let db: ReturnType<typeof openControlPlaneDatabase> | null = null;

  try {
    db = await withProvisionStep({
      communityId,
      requestId: input.requestId,
      step: "open_control_plane",
    }, async () => openControlPlaneDatabase({
      url: controlPlaneDatabaseUrl,
      authToken: controlPlaneAuthToken,
    }));
    const namespaceVerification = await withProvisionStep({
      communityId,
      requestId: input.requestId,
      step: "load_namespace_verification",
    }, async () => namespaceVerificationId
      ? requireNamespaceVerification(db!, {
          namespaceVerificationId,
          creatorUserId,
        })
      : null);

    const platform = new TursoPlatformClient({
      apiToken: tursoPlatformApiToken,
      fetch: input.fetch,
    });

    let group = await withProvisionStep({
      communityId,
      requestId: input.requestId,
      step: "ensure_group",
    }, async () => (await platform.listGroups(tursoOrganizationSlug))
      .find((entry) => entry.name === groupName)
      ?? await platform.createGroup({
        organizationSlug: tursoOrganizationSlug,
        groupName,
        location: groupLocation,
      }));

    if (group.deleteProtection !== true) {
      group = await withProvisionStep({
        communityId,
        requestId: input.requestId,
        step: "enable_group_delete_protection",
      }, async () => ({
        ...group,
        ...await platform.updateGroupConfiguration({
          organizationSlug: tursoOrganizationSlug,
          groupName,
          deleteProtection: true,
        }),
      }));
    }

    let database = await withProvisionStep({
      communityId,
      requestId: input.requestId,
      step: "ensure_database",
    }, async () => (await platform.listDatabases({
        organizationSlug: tursoOrganizationSlug,
        groupName,
      }))
        .find((entry) => entry.name === databaseName)
        ?? await platform.createDatabase({
          organizationSlug: tursoOrganizationSlug,
          databaseName,
          groupName,
        }));

    if (database.deleteProtection !== true) {
      database = await withProvisionStep({
        communityId,
        requestId: input.requestId,
        step: "enable_database_delete_protection",
      }, async () => ({
        ...database,
        ...await platform.updateDatabaseConfiguration({
          organizationSlug: tursoOrganizationSlug,
          databaseName,
          deleteProtection: true,
        }),
      }));
    }

    const databaseUrl = requireText(database.libsqlUrl, "database.libsqlUrl");
    const minted = await withProvisionStep({
      communityId,
      requestId: input.requestId,
      step: "mint_database_token",
    }, async () => platform.createDatabaseAuthToken({
        organizationSlug: tursoOrganizationSlug,
        databaseName,
        expiration: databaseTokenExpiration ?? undefined,
        authorization: "full-access",
      }));
    const plaintextToken = requireText(minted.jwt, "minted database auth token");

    const namespaceLabel = input.namespaceLabel?.trim() || namespaceVerification?.normalized_root_label || null;
    await withProvisionStep({
      communityId,
      requestId: input.requestId,
      step: "bootstrap_database",
    }, async () => bootstrapFn({
        databaseUrl,
        databaseAuthToken: plaintextToken,
        communityId,
        userId: creatorUserId,
        displayName,
        namespaceVerificationId,
        description: input.description?.trim() || null,
        avatarRef: input.avatarRef?.trim() || null,
        bannerRef: input.bannerRef?.trim() || null,
        membershipMode: input.membershipMode ?? "open",
        defaultAgeGatePolicy: input.defaultAgeGatePolicy ?? "none",
        gatePolicy: input.gatePolicy ?? null,
        membershipUniqueHumanProvider: input.membershipUniqueHumanProvider ?? null,
        postingUniqueHumanProvider: input.postingUniqueHumanProvider ?? null,
        handlePolicyTemplate: input.handlePolicyTemplate ?? "standard",
        handlePricingModel: input.handlePricingModel ?? null,
        namespaceLabel,
        initialSettings: input.initialSettings ?? null,
        now: input.now ?? new Date(),
      }));

    const rotationNumber = await withProvisionStep({
      communityId,
      requestId: input.requestId,
      step: "load_next_rotation",
    }, async () => getNextRotationNumber(db!, {
        communityId,
      }));
    const tokenName = `worker-${communityId}-v${rotationNumber}`;

    return {
      communityId,
      organizationSlug: tursoOrganizationSlug,
      groupName,
      groupId: group.uuid ?? null,
      databaseName,
      databaseId: database.dbId ?? null,
      databaseUrl,
      location: groupLocation,
      tokenName,
      plaintextToken,
      issuedAt: timestamp,
      expiresAt: null,
      rotationNumber,
    };
  } finally {
    if (db) {
      await db.close();
    }
  }
}

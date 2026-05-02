export type CommunityRow = {
  community_id: string;
  creator_user_id: string;
  primary_database_binding_id: string | null;
  provisioning_state: string;
  status?: string;
  transfer_state?: string;
  route_slug?: string | null;
};

export type NamespaceVerificationRow = {
  namespace_verification_id: string;
  user_id: string;
  status: string;
  club_attach_allowed: number;
  normalized_root_label: string;
};

export type BindingRow = {
  community_database_binding_id: string;
  community_id: string;
  organization_slug: string;
  group_name: string;
  database_name: string;
  database_url: string;
  location: string | null;
  status: string;
};

export type ActiveCredentialRow = {
  community_db_credential_id: string;
  encrypted_token: string;
  encryption_key_version: number;
  token_name: string;
};

export type TaggedQueryExecutor = <T = unknown[]>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T>;

export type ControlPlaneQueryable = {
  sql: TaggedQueryExecutor;
};

export type ControlPlaneDatabase = ControlPlaneQueryable & {
  begin<T>(callback: (tx: ControlPlaneQueryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

export type ProvisionCommunityInput = {
  controlPlaneDatabaseUrl: string;
  controlPlaneAuthToken?: string | null;
  tursoPlatformApiToken: string;
  tursoOrganizationSlug: string;
  tursoCommunityDbWrapKey?: string;
  tursoCommunityDbWrapKeyVersion?: number;
  communityId: string;
  creatorUserId: string;
  displayName: string;
  namespaceVerificationId?: string | null;
  groupLocation: string;
  description?: string | null;
  avatarRef?: string | null;
  bannerRef?: string | null;
  membershipMode?: "open" | "request" | "gated";
  defaultAgeGatePolicy?: "none" | "18_plus";
  gatePolicy?: Record<string, unknown> | null;
  membershipUniqueHumanProvider?: "self" | "very" | null;
  postingUniqueHumanProvider?: "self" | "very" | null;
  handlePolicyTemplate?: "standard" | "premium" | "membership_gated" | "custom";
  handlePricingModel?: string | null;
  namespaceLabel?: string | null;
  initialSettings?: Record<string, unknown> | null;
  databaseTokenExpiration?: string | null;
  requestId?: string | null;
  fetch?: typeof globalThis.fetch;
  bootstrapCommunityDatabaseFn?: (
    input: import("./community-bootstrap").BootstrapCommunityDatabaseInput,
  ) => Promise<{ databaseUrl: string; communityId: string; namespaceId: string | null }>;
  now?: Date;
};

export type ProvisionCommunityRuntimeResult = {
  communityId: string;
  organizationSlug: string;
  groupName: string;
  groupId: string | null;
  databaseName: string;
  databaseId: string | null;
  databaseUrl: string;
  location: string | null;
  tokenName: string;
  plaintextToken: string;
  issuedAt: string;
  expiresAt: string | null;
  rotationNumber: number;
};

export type RotateCommunityTokenInput = {
  controlPlaneDatabaseUrl: string;
  controlPlaneAuthToken?: string | null;
  tursoPlatformApiToken: string;
  tursoCommunityDbWrapKey: string;
  tursoCommunityDbWrapKeyVersion: number;
  communityId: string;
  reason?: string | null;
  databaseTokenExpiration?: string | null;
  fetch?: typeof globalThis.fetch;
  now?: Date;
};

export type RotateCommunityTokenResult = {
  communityId: string;
  communityDatabaseBindingId: string;
  communityDbCredentialId: string;
  databaseName: string;
  databaseUrl: string;
  tokenName: string;
  rotationNumber: number;
};

export type DoctorInput = {
  controlPlaneDatabaseUrl: string;
  controlPlaneAuthToken?: string | null;
  communityId?: string | null;
  tursoCommunityDbWrapKey?: string | null;
  inspectCommunityDatabaseSchemaFn?: (input: {
    databaseUrl: string;
    databaseAuthToken: string;
    expectedMigrations: Array<{ migrationName: string; checksum: string }>;
  }) => Promise<{
    missingMigrationNames: string[];
    mismatchedMigrationNames: string[];
    unexpectedMigrationNames: string[];
  }>;
};

export type DoctorFinding = {
  severity: "error";
  code:
    | "community_not_active"
    | "community_transfer_state_invalid"
    | "route_slug_namespace_collision"
    | "community_missing_active_primary_binding"
    | "community_primary_binding_mismatch"
    | "binding_group_name_mismatch"
    | "binding_database_name_mismatch"
    | "binding_database_url_invalid"
    | "binding_missing_active_credential"
    | "binding_schema_migrations_unreadable"
    | "binding_schema_migrations_mismatch";
  communityId: string;
  communityDatabaseBindingId: string | null;
  message: string;
};

export type DoctorResult = {
  checkedCommunityCount: number;
  checkedBindingCount: number;
  checkedCredentialCount: number;
  findingCount: number;
  findings: DoctorFinding[];
};

export type ReapStaleCommunityProvisioningInput = {
  controlPlaneDatabaseUrl: string;
  controlPlaneAuthToken?: string | null;
  staleAfterMs?: number;
  now?: Date;
};

export type ReapedCommunityProvisioningJob = {
  jobId: string;
  communityId: string;
  updatedAt: string;
};

export type ReapStaleCommunityProvisioningResult = {
  cutoff: string;
  staleAfterMs: number;
  reapedJobs: ReapedCommunityProvisioningJob[];
  reapedJobCount: number;
};

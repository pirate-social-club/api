-- Idempotent staging-only data seed for the Web required release contract.
--
-- This deliberately creates no HNS verification or route. The contract reads
-- the local active namespace/policy join only; the dedicated community and its
-- control-plane route already exist. DB_CMTY_FIXTURE is structurally reserved
-- by the shard worker and must be the only target for this file.

INSERT INTO namespace_bindings (
  namespace_id,
  community_id,
  namespace_verification_id,
  display_label,
  normalized_label,
  resolver_label,
  route_family,
  status,
  created_at,
  updated_at,
  namespace_role
) VALUES (
  'ns_e2e_handle_claim_fixture',
  'cmt_541911f4cd9145398b7fa79ddc0542fe',
  'nsv_e2e_handle_claim_fixture',
  'E2E Handle Claim Fixture',
  'e2e-handle-claim-fixture',
  NULL,
  NULL,
  'active',
  '2026-07-31T00:00:00.000Z',
  '2026-07-31T00:00:00.000Z',
  'primary'
)
ON CONFLICT(namespace_id) DO UPDATE SET
  community_id = excluded.community_id,
  namespace_verification_id = excluded.namespace_verification_id,
  display_label = excluded.display_label,
  normalized_label = excluded.normalized_label,
  status = 'active',
  namespace_role = 'primary',
  updated_at = excluded.updated_at;

INSERT INTO namespace_handle_policies (
  namespace_handle_policy_id,
  community_id,
  namespace_id,
  policy_template,
  pricing_model,
  membership_required_for_claim,
  settings_json,
  created_at,
  updated_at,
  claims_enabled,
  claim_gate_mode,
  claim_gate_expression_ref,
  eligibility_timing,
  revision
) VALUES (
  'nhp_e2e_handle_claim_fixture',
  'cmt_541911f4cd9145398b7fa79ddc0542fe',
  'ns_e2e_handle_claim_fixture',
  'standard',
  'free',
  1,
  NULL,
  '2026-07-31T00:00:00.000Z',
  '2026-07-31T00:00:00.000Z',
  1,
  'none',
  NULL,
  'claim_time',
  1
)
ON CONFLICT(namespace_handle_policy_id) DO UPDATE SET
  community_id = excluded.community_id,
  namespace_id = excluded.namespace_id,
  claims_enabled = 1,
  updated_at = excluded.updated_at;

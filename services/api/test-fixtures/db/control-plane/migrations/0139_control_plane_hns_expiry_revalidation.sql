-- HNS expiry assertions accepted before the authenticated hsd observer landed
-- were derived from root/resource existence. They are not reinterpreted here:
-- clearing last_revalidated_at makes them explicit first-priority candidates
-- for the scheduled revalidation worker, which must write fresh chain evidence.

UPDATE namespace_verification_assertions
SET last_revalidated_at = NULL
WHERE family = 'hns'
  AND assertion_name = 'expiry_horizon_sufficient'
  AND status = 'accepted'
  AND NOT EXISTS (
    SELECT 1
    FROM namespace_verification_evidence_bundles AS evidence
    WHERE evidence.evidence_bundle_id = namespace_verification_assertions.source_evidence_bundle_id
      AND CAST(evidence.raw_response_json AS TEXT) LIKE '%"expiry_observation_provider"%'
      AND CAST(evidence.raw_response_json AS TEXT) LIKE '%hsd_json_rpc%'
  );

CREATE INDEX idx_namespace_verification_assertions_hns_expiry_revalidation
    ON namespace_verification_assertions(family, assertion_name, status, last_revalidated_at)
    WHERE family = 'hns' AND assertion_name = 'expiry_horizon_sufficient';

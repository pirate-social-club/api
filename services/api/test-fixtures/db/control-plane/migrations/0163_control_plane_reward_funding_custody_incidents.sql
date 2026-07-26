-- A reward-funding receipt containing expected-token deposits from multiple
-- senders proves treasury custody without identifying one safe automatic
-- refund recipient. Retain the inventory for operator review and keep it out
-- of the automatic refund worklist.

ALTER TABLE reward_campaign_funding_effects
  DROP CONSTRAINT reward_campaign_funding_effects_status_check,
  ADD COLUMN custody_evidence_json JSONB,
  ADD CONSTRAINT reward_campaign_funding_effects_status_check CHECK (status IN (
    'quoted', 'confirming', 'confirmed', 'failed',
    'refund_pending', 'operator_incident', 'refunded'
  )),
  ADD CONSTRAINT reward_campaign_funding_effects_custody_incident_shape_check
    CHECK (
      status <> 'operator_incident'
      OR (
        tx_hash IS NOT NULL
        AND custody_evidence_json IS NOT NULL
        AND jsonb_typeof(custody_evidence_json) = 'object'
        AND jsonb_typeof(custody_evidence_json -> 'transfers') = 'array'
        AND jsonb_array_length(custody_evidence_json -> 'transfers') > 1
      )
    );

CREATE INDEX reward_campaign_funding_effects_operator_incident_idx
  ON reward_campaign_funding_effects(updated_at, reward_campaign_funding_effect_id)
  WHERE status = 'operator_incident';

ALTER TABLE reward_campaign_incidents
  DROP CONSTRAINT reward_campaign_incidents_incident_kind_check,
  ADD CONSTRAINT reward_campaign_incidents_incident_kind_check CHECK (incident_kind IN (
    'accounting_mismatch', 'funding_finality_failure', 'funding_provenance_missing',
    'funding_custody_ambiguous'
  ));

import type { Client } from "../../sql-client"

export async function reconcileCommittedLocalNamespaceAttachment(
  operation: () => Promise<void>,
  onFailure: (error: unknown) => void,
): Promise<boolean> {
  try {
    await operation()
    return true
  } catch (error) {
    onFailure(error)
    return false
  }
}

export async function supersedePromotedLocalMirror(
  client: Pick<Client, "execute">,
  input: {
    communityId: string
    namespaceVerificationId: string
    primaryNamespaceId: string
    updatedAt: string
  },
): Promise<void> {
  // Zero rows is expected for ordinary primary attaches that never had a
  // mirror. This is reconciliation, not a precondition check.
  await client.execute({
    sql: `
      UPDATE namespace_bindings
      SET status = 'superseded',
          updated_at = ?4
      WHERE community_id = ?1
        AND namespace_verification_id = ?2
        AND namespace_role = 'mirror'
        AND status = 'active'
        AND namespace_id != ?3
    `,
    args: [
      input.communityId,
      input.namespaceVerificationId,
      input.primaryNamespaceId,
      input.updatedAt,
    ],
  })
}

export async function writeLocalNamespaceAttachment(
  client: Pick<Client, "execute">,
  input: {
    communityId: string
    namespaceVerificationId: string
    namespaceRole: "primary" | "mirror"
    namespaceLabel: string
    now: string
  },
): Promise<void> {
  const namespaceKey = input.namespaceRole === "primary"
    ? input.communityId
    : input.namespaceVerificationId
  const namespaceId = `ns_${namespaceKey}`
  const namespaceHandlePolicyId = `nhp_${namespaceKey}`

  if (input.namespaceRole === "primary") {
    await supersedePromotedLocalMirror(client, {
      communityId: input.communityId,
      namespaceVerificationId: input.namespaceVerificationId,
      primaryNamespaceId: namespaceId,
      updatedAt: input.now,
    })
  }

  await client.execute({
    sql: `
      INSERT INTO namespace_bindings (
        namespace_id, community_id, namespace_verification_id, display_label, normalized_label,
        resolver_label, route_family, status, created_at, updated_at, namespace_role
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, NULL, NULL, 'active', ?6, ?6, ?7
      )
      ON CONFLICT(namespace_id) DO UPDATE SET
        namespace_verification_id = excluded.namespace_verification_id,
        display_label = excluded.display_label,
        normalized_label = excluded.normalized_label,
        namespace_role = excluded.namespace_role,
        status = excluded.status,
        updated_at = excluded.updated_at
    `,
    args: [
      namespaceId,
      input.communityId,
      input.namespaceVerificationId,
      input.namespaceLabel,
      input.namespaceLabel.toLowerCase(),
      input.now,
      input.namespaceRole,
    ],
  })

  await client.execute({
    sql: `
      INSERT INTO namespace_handle_policies (
        namespace_handle_policy_id, community_id, namespace_id, policy_template, pricing_model,
        membership_required_for_claim, claims_enabled, settings_json, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, 'premium', 'flat_by_length', 1, ?4, ?5, ?6, ?6
      )
      ON CONFLICT(namespace_handle_policy_id) DO UPDATE SET
        namespace_id = excluded.namespace_id,
        membership_required_for_claim = excluded.membership_required_for_claim,
        updated_at = excluded.updated_at
    `,
    args: [
      namespaceHandlePolicyId,
      input.communityId,
      namespaceId,
      0,
      JSON.stringify({
        flat_price_cents: 500,
        premium_price_cents: 2500,
        premium_max_length: 4,
        min_length: 3,
        max_length: 32,
        special_price_cents_by_label: {
          crown: 100000,
          "xn--2p8h": 100000,
          prince: 50000,
          "xn--tq9h": 50000,
          princess: 50000,
          "xn--6q8h": 50000,
          diamond: 75000,
          "xn--tr8h": 75000,
          ring: 50000,
          "xn--sr8h": 50000,
          "xn--cs8h": 50000,
          "xn--cz8h": 25000,
        },
      }),
      input.now,
    ],
  })
}

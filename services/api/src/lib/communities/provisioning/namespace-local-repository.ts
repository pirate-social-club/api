import type { Client } from "../../sql-client"

export async function supersedePromotedLocalMirror(
  client: Pick<Client, "execute">,
  input: {
    communityId: string
    namespaceVerificationId: string
    primaryNamespaceId: string
    updatedAt: string
  },
): Promise<void> {
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

import { executeFirst, type DbExecutor } from "../db-helpers"
import { makeId } from "../helpers"
import type {
  NotificationTasksResponse,
  UserTask,
  UserTaskStatus,
  UserTaskType,
} from "../../types"
import { nullableUnixSeconds, unixSeconds } from "../../serializers/time"

function rowToUserTask(row: Record<string, unknown>): UserTask {
  return {
    id: `task_${String(row.task_id)}`,
    object: "user_task",
    user: `usr_${String(row.user_id)}`,
    type: String(row.type) as UserTaskType,
    subject_type: String(row.subject_type),
    subject: String(row.subject_id),
    status: String(row.status) as UserTaskStatus,
    priority: Number(row.priority ?? 0),
    payload: row.payload_json ? JSON.parse(String(row.payload_json)) : null,
    resolved_at: nullableUnixSeconds(row.resolved_at ? String(row.resolved_at) : null),
    dismissed_at: nullableUnixSeconds(row.dismissed_at ? String(row.dismissed_at) : null),
    created: unixSeconds(String(row.created_at)),
  }
}

const USER_TASK_COLUMNS = `
  task_id, user_id, type, subject_type, subject_id, status, priority, payload_json,
  resolved_at, dismissed_at, created_at, updated_at
`

export async function upsertUserTask(input: {
  executor: DbExecutor
  userId: string
  type: UserTaskType
  subjectType: string
  subjectId: string
  priority?: number
  payload?: Record<string, unknown> | null
  status?: UserTaskStatus
  createdAt: string
}): Promise<{ task: UserTask; wasCreated: boolean }> {
  const taskId = makeId("tsk")
  const payloadJson = input.payload ? JSON.stringify(input.payload) : null
  const status = input.status ?? "open"
  const priority = input.priority ?? 0

  try {
    await input.executor.execute({
      sql: `
        INSERT INTO user_tasks (task_id, user_id, type, subject_type, subject_id, status, priority, payload_json, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
      `,
      args: [taskId, input.userId, input.type, input.subjectType, input.subjectId, status, priority, payloadJson, input.createdAt],
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("UNIQUE") || message.includes("unique") || message.includes("duplicate")) {
      await input.executor.execute({
        sql: `
          UPDATE user_tasks
          SET priority = ?4,
              payload_json = ?5,
              updated_at = ?6
          WHERE user_id = ?1
            AND type = ?2
            AND subject_id = ?3
            AND status = 'open'
        `,
        args: [input.userId, input.type, input.subjectId, priority, payloadJson, input.createdAt],
      })
      const existing = await executeFirst(input.executor, {
        sql: `
          SELECT ${USER_TASK_COLUMNS}
          FROM user_tasks
          WHERE user_id = ?1 AND type = ?2 AND subject_id = ?3 AND status = 'open'
          LIMIT 1
        `,
        args: [input.userId, input.type, input.subjectId],
      }) as Record<string, unknown> | null
      if (existing) {
        return { task: rowToUserTask(existing), wasCreated: false }
      }
    }
    throw error
  }

  return {
    task: {
      id: `task_${taskId}`,
      object: "user_task",
      user: `usr_${input.userId}`,
      type: input.type,
      subject_type: input.subjectType,
      subject: input.subjectId,
      status,
      priority,
      payload: input.payload ?? null,
      resolved_at: null,
      dismissed_at: null,
      created: unixSeconds(input.createdAt),
    },
    wasCreated: true,
  }
}

export async function resolveUserTask(input: {
  executor: DbExecutor
  userId: string
  type: UserTaskType
  subjectId: string
  resolvedAt: string
}): Promise<void> {
  await input.executor.execute({
    sql: `
      UPDATE user_tasks
      SET status = 'completed', resolved_at = ?1, updated_at = ?1
      WHERE user_id = ?2 AND type = ?3 AND subject_id = ?4 AND status = 'open'
    `,
    args: [input.resolvedAt, input.userId, input.type, input.subjectId],
  })
}

export async function dismissUserTask(input: {
  executor: DbExecutor
  taskId: string
  userId: string
  dismissedAt: string
}): Promise<{ task: UserTask; wasDismissed: boolean } | null> {
  const result = await input.executor.execute({
    sql: `
      UPDATE user_tasks
      SET status = 'dismissed', dismissed_at = ?1, updated_at = ?1
      WHERE task_id = ?2 AND user_id = ?3 AND status = 'open'
    `,
    args: [input.dismissedAt, input.taskId, input.userId],
  })

  const row = await executeFirst(input.executor, {
    sql: `
      SELECT ${USER_TASK_COLUMNS}
      FROM user_tasks
      WHERE task_id = ?1 AND user_id = ?2
    `,
    args: [input.taskId, input.userId],
  }) as Record<string, unknown> | null
  if (!row) {
    return null
  }

  const wasDismissed = Boolean(result.rowsAffected && result.rowsAffected > 0)
  return { task: rowToUserTask(row), wasDismissed }
}

export async function listOpenUserTasks(input: {
  executor: DbExecutor
  userId: string
}): Promise<NotificationTasksResponse> {
  const result = await input.executor.execute({
    sql: `
      SELECT ${USER_TASK_COLUMNS}
      FROM user_tasks
      WHERE user_id = ?1 AND status = 'open'
      ORDER BY priority DESC, updated_at DESC
    `,
    args: [input.userId],
  })
  return { items: result.rows.map(rowToUserTask), next_cursor: null }
}

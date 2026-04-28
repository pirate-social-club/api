import { nowIso } from "../helpers"
import { executeFirst, type DbExecutor } from "../db-helpers"
import { getGlobalHandleRow, getProfileRow, getUserRow } from "../auth/auth-db-user-queries"
import { parseVerificationCapabilities } from "../auth/auth-serializers"
import { resolveUserTask, upsertUserTask } from "./notification-task-store"
import type { UserTask } from "../../types"

const SYNTHETIC_UNIQUE_HUMAN_TASK_ID_PREFIX = "synth:unique_human:"
export const UNIQUE_HUMAN_TASK_TYPE = "unique_human_verification_required"
const PROFILE_COMPLETION_TASK_TYPE = "profile_completion_suggested"
const GLOBAL_HANDLE_CLEANUP_TASK_TYPE = "global_handle_cleanup_suggested"

export function isSyntheticUniqueHumanTaskId(taskId: string): boolean {
  return taskId.startsWith(SYNTHETIC_UNIQUE_HUMAN_TASK_ID_PREFIX)
}

export function buildUniqueHumanTask(userId: string): UserTask {
  const createdAt = nowIso()
  return {
    task_id: `${SYNTHETIC_UNIQUE_HUMAN_TASK_ID_PREFIX}${userId}`,
    user_id: userId,
    type: UNIQUE_HUMAN_TASK_TYPE,
    subject_type: "user",
    subject_id: userId,
    status: "open",
    priority: 100,
    payload: {
      target_path: "/onboarding?verify=human",
      verification_provider: "very",
    },
    resolved_at: null,
    dismissed_at: null,
    created_at: createdAt,
    updated_at: createdAt,
  }
}

export async function needsUniqueHumanTask(executor: DbExecutor, userId: string): Promise<boolean> {
  const userRow = await getUserRow(executor, userId)
  if (!userRow) return false
  const capabilities = parseVerificationCapabilities(userRow.verification_capabilities_json)
  return capabilities.unique_human.state !== "verified"
}

function isProfileComplete(profile: Awaited<ReturnType<typeof getProfileRow>>): boolean {
  if (!profile?.display_name?.trim()) return false
  return Boolean(profile.avatar_ref?.trim() || profile.cover_ref?.trim() || profile.bio?.trim())
}

async function hasDismissedUserTask(executor: DbExecutor, input: {
  userId: string
  type: typeof PROFILE_COMPLETION_TASK_TYPE | typeof GLOBAL_HANDLE_CLEANUP_TASK_TYPE
  subjectId: string
}): Promise<boolean> {
  const row = await executeFirst(executor, {
    sql: `
      SELECT task_id
      FROM user_tasks
      WHERE user_id = ?1
        AND type = ?2
        AND subject_id = ?3
        AND status = 'dismissed'
      LIMIT 1
    `,
    args: [input.userId, input.type, input.subjectId],
  }) as Record<string, unknown> | null
  return Boolean(row)
}

async function syncProfileCompletionTask(executor: DbExecutor, userId: string): Promise<void> {
  const profile = await getProfileRow(executor, userId)
  if (isProfileComplete(profile)) {
    await resolveUserTask({
      executor,
      userId,
      type: PROFILE_COMPLETION_TASK_TYPE,
      subjectId: userId,
      resolvedAt: nowIso(),
    })
    return
  }

  if (await hasDismissedUserTask(executor, { userId, type: PROFILE_COMPLETION_TASK_TYPE, subjectId: userId })) {
    return
  }

  await upsertUserTask({
    executor,
    userId,
    type: PROFILE_COMPLETION_TASK_TYPE,
    subjectType: "profile",
    subjectId: userId,
    priority: 1,
    payload: { target_path: "/settings/profile" },
    createdAt: nowIso(),
  })
}

async function needsGlobalHandleCleanupTask(executor: DbExecutor, userId: string): Promise<boolean> {
  const user = await getUserRow(executor, userId)
  if (user?.onboarding_dismissed_at) return false

  const profile = await getProfileRow(executor, userId)
  if (!profile) return false
  const activeGlobalHandle = await getGlobalHandleRow(executor, profile.global_handle_id)
  return activeGlobalHandle?.issuance_source === "generated_signup"
    && !Boolean(activeGlobalHandle.free_rename_consumed)
}

async function syncGlobalHandleCleanupTask(executor: DbExecutor, userId: string): Promise<void> {
  if (!(await needsGlobalHandleCleanupTask(executor, userId))) {
    await resolveUserTask({
      executor,
      userId,
      type: GLOBAL_HANDLE_CLEANUP_TASK_TYPE,
      subjectId: userId,
      resolvedAt: nowIso(),
    })
    return
  }

  if (await hasDismissedUserTask(executor, { userId, type: GLOBAL_HANDLE_CLEANUP_TASK_TYPE, subjectId: userId })) {
    return
  }

  await upsertUserTask({
    executor,
    userId,
    type: GLOBAL_HANDLE_CLEANUP_TASK_TYPE,
    subjectType: "profile",
    subjectId: userId,
    priority: 2,
    payload: { target_path: "/settings/profile" },
    createdAt: nowIso(),
  })
}

export async function syncUserNotificationTasks(executor: DbExecutor, userId: string): Promise<void> {
  await syncProfileCompletionTask(executor, userId)
  await syncGlobalHandleCleanupTask(executor, userId)
}

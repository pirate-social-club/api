export { makeId, nowIso, requireText, trim } from "@pirate/api-shared";

export function requirePositiveInt(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

export function normalizeTursoName(value: string): string {
  return value.trim().toLowerCase().replace(/_/g, "-");
}

export function buildRegionPoolGroupName(groupLocation: string): string {
  return `region-${normalizeTursoName(groupLocation)}`;
}

export function buildCommunityDatabaseName(communityId: string): string {
  return `main-${normalizeTursoName(communityId)}`;
}

export function parseRotationNumber(communityId: string, tokenName: string): number {
  const match = new RegExp(`^worker-${communityId}-v(\\d+)$`).exec(tokenName.trim());
  return match ? Number(match[1]) : 0;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function withProvisionStep<T>(
  input: {
    communityId: string;
    requestId?: string | null;
    step: string;
  },
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  logProvisionStep({ ...input, event: "start" });
  try {
    const result = await operation();
    logProvisionStep({ ...input, event: "success", startedAt });
    return result;
  } catch (error) {
    if (error instanceof Error) {
      (error as Error & { provisionStep?: string }).provisionStep = input.step;
    }
    logProvisionStep({ ...input, event: "error", startedAt, error });
    throw error;
  }
}

function logProvisionStep(input: {
  communityId: string;
  requestId?: string | null;
  step: string;
  event: "start" | "success" | "error";
  startedAt?: number;
  error?: unknown;
}): void {
  const fields = [
    "[community-provision]",
    `community_id=${input.communityId}`,
    input.requestId ? `request_id=${input.requestId}` : null,
    `step=${input.step}`,
    `event=${input.event}`,
    input.startedAt == null ? null : `took_ms=${Math.max(0, Math.round(performance.now() - input.startedAt))}`,
    input.error == null ? null : `error=${JSON.stringify(errorMessage(input.error))}`,
  ].filter(Boolean);
  console.log(fields.join(" "));
}

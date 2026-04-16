export function normalizeRootLabel(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
}

export function ensureAtPrefix(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

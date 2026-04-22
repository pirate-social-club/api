export function normalizeRootLabel(value: string): string {
  const trimmed = value.trim().normalize("NFKC").toLowerCase();
  const unprefixed = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  return toAsciiRootLabel(unprefixed);
}

export function ensureAtPrefix(value: string): string {
  const trimmed = normalizeRootLabel(value);
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

function toAsciiRootLabel(value: string): string {
  if (!value || value.includes(".")) {
    return value;
  }

  if (/^[\x00-\x7F]+$/u.test(value)) {
    return value;
  }

  try {
    const hostname = new URL(`http://${value}.invalid`).hostname;
    return hostname.endsWith(".invalid") ? hostname.slice(0, -".invalid".length) : value;
  } catch {
    return value;
  }
}

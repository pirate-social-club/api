export function normalizeRootLabel(value: string): string {
  const trimmed = value.trim().normalize("NFKC").toLowerCase();
  const unprefixed = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  return toAsciiRootLabel(unprefixed) ?? unprefixed;
}

export function ensureAtPrefix(value: string): string {
  const trimmed = normalizeRootLabel(value);
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

function toAsciiRootLabel(value: string): string | null {
  if (!value || value.includes(".")) {
    return value;
  }

  if (/^[\x00-\x7F]+$/u.test(value) && !value.startsWith("xn--")) {
    return value;
  }

  try {
    const hostname = new URL(`http://${value}.invalid`).hostname;
    if (!hostname.endsWith(".invalid")) {
      return null;
    }

    const asciiLabel = hostname.slice(0, -".invalid".length);
    return value.startsWith("xn--") && asciiLabel !== value ? null : asciiLabel;
  } catch {
    return null;
  }
}

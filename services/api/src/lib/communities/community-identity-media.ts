function hashSeed(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}

function encodeSvg(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(toWellFormedText(svg))}`;
}

function toWellFormedText(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        result += value[index] + value[index + 1];
        index += 1;
      } else {
        result += "\uFFFD";
      }
      continue;
    }
    if (code >= 0xDC00 && code <= 0xDFFF) {
      result += "\uFFFD";
      continue;
    }
    result += value[index];
  }
  return result;
}

function escapeSvgText(value: string): string {
  return toWellFormedText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sanitizeLabel(value: string): string {
  return toWellFormedText(value).trim().replace(/\s+/g, " ");
}

function buildInitials(displayName: string): string {
  const parts = sanitizeLabel(displayName)
    .split(" ")
    .filter(Boolean)
    .slice(0, 2);

  if (parts.length === 0) {
    return "C";
  }

  return parts.map((part) => Array.from(part)[0]?.toUpperCase() ?? "").join("") || "C";
}

export function normalizeCommunityMediaRef(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function buildDefaultCommunityAvatarRef(input: {
  communityId: string;
  displayName: string;
}): string {
  const seed = `${input.communityId.trim()}:${sanitizeLabel(input.displayName)}`;
  const hash = hashSeed(seed);
  const palette = [
    { bg: "#243f46", fg: "#d9f0f2" },
    { bg: "#314936", fg: "#e2f3de" },
    { bg: "#3f3a5f", fg: "#ece8ff" },
    { bg: "#4b4555", fg: "#f0eaf6" },
    { bg: "#33465f", fg: "#e6eef8" },
    { bg: "#4c4a37", fg: "#f4f0d9" },
  ];
  const colors = palette[hash % palette.length];
  const initials = buildInitials(input.displayName);
  const safeInitials = escapeSvgText(initials);

  return encodeSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="${initials}">
      <rect width="128" height="128" rx="64" fill="${colors.bg}" />
      <path d="M24 92C38 74 53 65 68 65C83 65 95 72 104 86" fill="none" stroke="rgba(255,255,255,0.16)" stroke-width="10" stroke-linecap="round" />
      <text x="50%" y="55%" text-anchor="middle" dominant-baseline="middle"
            fill="${colors.fg}" font-family="system-ui, Arial, sans-serif"
            font-size="44" font-weight="700">${safeInitials}</text>
    </svg>`,
  );
}

export function buildDefaultCommunityBannerRef(input: {
  communityId: string;
  displayName: string;
}): string {
  const seed = `${input.communityId}:${sanitizeLabel(input.displayName)}:banner`;
  const hash = hashSeed(seed);
  const hue = hash % 360;
  const accentHue = (hue + 52) % 360;
  const tertiaryHue = (hue + 128) % 360;
  const label = escapeSvgText(sanitizeLabel(input.displayName));

  return encodeSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 320" role="img" aria-label="${label} banner">
      <defs>
        <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="hsl(${hue} 60% 17%)" />
          <stop offset="48%" stop-color="hsl(${accentHue} 68% 22%)" />
          <stop offset="100%" stop-color="hsl(${tertiaryHue} 62% 15%)" />
        </linearGradient>
        <radialGradient id="glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="rgba(255,255,255,0.22)" />
          <stop offset="100%" stop-color="rgba(255,255,255,0)" />
        </radialGradient>
      </defs>
      <rect width="1600" height="320" fill="url(#bg)" />
      <circle cx="260" cy="88" r="180" fill="url(#glow)" />
      <circle cx="1340" cy="54" r="148" fill="rgba(255,255,255,0.08)" />
      <path d="M0 252C118 206 260 180 428 182C594 184 744 226 924 228C1112 230 1270 176 1600 110V320H0Z"
            fill="rgba(255,255,255,0.08)" />
      <path d="M0 274C202 210 354 202 538 220C734 240 914 282 1118 272C1294 264 1448 220 1600 176V320H0Z"
            fill="rgba(0,0,0,0.16)" />
    </svg>`,
  );
}

export function resolveCommunityAvatarRef(input: {
  communityId: string;
  displayName: string;
  avatarRef?: string | null;
}): string {
  return normalizeCommunityMediaRef(input.avatarRef)
    ?? buildDefaultCommunityAvatarRef(input);
}

export function resolveCommunityBannerRef(input: {
  communityId: string;
  displayName: string;
  bannerRef?: string | null;
}): string {
  return normalizeCommunityMediaRef(input.bannerRef)
    ?? buildDefaultCommunityBannerRef(input);
}

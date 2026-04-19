function hashSeed(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}

function encodeSvg(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function sanitizeLabel(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function buildInitials(displayName: string): string {
  const parts = sanitizeLabel(displayName)
    .split(" ")
    .filter(Boolean)
    .slice(0, 2);

  if (parts.length === 0) {
    return "C";
  }

  return parts.map((part) => part[0]?.toUpperCase() ?? "").join("") || "C";
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
  const hash = hashSeed(input.communityId.trim());
  const hue = hash % 360;
  const secondaryHue = (hue + 38) % 360;
  const initials = buildInitials(input.displayName);

  return encodeSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="${initials}">
      <defs>
        <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="hsl(${hue} 78% 58%)" />
          <stop offset="100%" stop-color="hsl(${secondaryHue} 82% 44%)" />
        </linearGradient>
      </defs>
      <rect width="128" height="128" rx="64" fill="url(#g)" />
      <circle cx="96" cy="32" r="18" fill="rgba(255,255,255,0.18)" />
      <text x="50%" y="55%" text-anchor="middle" dominant-baseline="middle"
            fill="rgba(255,255,255,0.96)" font-family="Inter, Arial, sans-serif"
            font-size="44" font-weight="700" letter-spacing="1">${initials}</text>
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

  return encodeSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 320" role="img" aria-label="${sanitizeLabel(input.displayName)} banner">
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

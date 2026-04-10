function randomInt(max: number, rng = Math.random): number {
  return Math.floor(rng() * max)
}

function pad4(value: number): string {
  return String(value).padStart(4, "0")
}

const ADJECTIVES = ["swift", "solar", "quiet", "brisk", "sable"]
const NOUNS = ["fox", "harbor", "signal", "anchor", "comet"]

export function formatDisplayLabel(labelNormalized: string): string {
  return `${labelNormalized}.pirate`
}

export function generateHandleCandidate(rng = Math.random): {
  labelNormalized: string
  labelDisplay: string
} {
  const adjective = ADJECTIVES[randomInt(ADJECTIVES.length, rng)]
  const noun = NOUNS[randomInt(NOUNS.length, rng)]
  const digits = pad4(randomInt(10_000, rng))
  const labelNormalized = `${adjective}-${noun}-${digits}`

  return {
    labelNormalized,
    labelDisplay: formatDisplayLabel(labelNormalized),
  }
}

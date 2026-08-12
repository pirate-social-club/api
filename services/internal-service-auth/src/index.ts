export function readBearerToken(request: Request): string {
  const value = request.headers.get("authorization") ?? ""
  return value.startsWith("Bearer ") ? value.slice("Bearer ".length).trim() : ""
}

export function constantTimeTextEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder()
  const leftBytes = encoder.encode(left)
  const rightBytes = encoder.encode(right)
  let difference = leftBytes.length ^ rightBytes.length
  const length = Math.max(leftBytes.length, rightBytes.length)
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0)
  }
  return difference === 0
}

export function hasValidBearerToken(request: Request, expectedToken: string): boolean {
  const expected = expectedToken.trim()
  return expected.length > 0 && constantTimeTextEqual(readBearerToken(request), expected)
}

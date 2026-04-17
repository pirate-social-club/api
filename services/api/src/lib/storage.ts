const IPFS_CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|bafy[a-z2-7]{20,})$/

function isIpfsCid(value: string): boolean {
  return IPFS_CID_RE.test(value)
}

export function extractIpfsCid(ref: string | null | undefined): string | null {
  const trimmed = (ref || "").trim()
  if (!trimmed) return null
  const lower = trimmed.toLowerCase()
  if (lower.startsWith("http://") || lower.startsWith("https://")) {
    try {
      const pathname = new URL(trimmed).pathname || ""
      const ipfsIndex = pathname.toLowerCase().indexOf("/ipfs/")
      if (ipfsIndex >= 0) {
        const cid = pathname
          .slice(ipfsIndex + "/ipfs/".length)
          .replace(/^\/+/, "")
          .split("/", 1)[0]?.trim() || ""
        return isIpfsCid(cid) ? cid : null
      }
    } catch {
      return null
    }
  }
  if (lower.startsWith("ipfs://ipfs/")) {
    const cid = trimmed.slice("ipfs://ipfs/".length).trim()
    return isIpfsCid(cid) ? cid : null
  }
  if (lower.startsWith("/ipfs/")) {
    const cid = trimmed.slice("/ipfs/".length).trim()
    return isIpfsCid(cid) ? cid : null
  }
  if (lower.startsWith("ipfs://")) {
    const cid = trimmed.slice("ipfs://".length).trim()
    return isIpfsCid(cid) ? cid : null
  }
  return isIpfsCid(trimmed) ? trimmed : null
}

export function toCanonicalIpfsUri(ref: string | null | undefined): string | null {
  const cid = extractIpfsCid(ref)
  return cid ? `ipfs://${cid}` : null
}

export type PublicReadCacheFillResult = {
  body: ArrayBuffer
  cacheable: boolean
  headers: [string, string][]
  status: number
  statusText: string
}

export const publicReadCacheFillRequests = new Map<string, Promise<PublicReadCacheFillResult>>()
export const publicReadCacheRefreshRequests = new Map<string, Promise<void>>()

export function resetPublicReadCacheDedupeForTests(): void {
  publicReadCacheFillRequests.clear()
  publicReadCacheRefreshRequests.clear()
}

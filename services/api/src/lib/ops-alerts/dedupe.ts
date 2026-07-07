import type { AlertDeduper } from "./emit"

export class KvAlertDeduper implements AlertDeduper {
  constructor(
    private readonly kv: KVNamespace,
    private readonly ttlSeconds: number,
  ) {}

  async hasSent(alertKey: string, bucketStartMs: number): Promise<boolean> {
    const key = `ops-alert:${alertKey}:${bucketStartMs}`
    return (await this.kv.get(key)) !== null
  }

  async markSent(alertKey: string, bucketStartMs: number): Promise<void> {
    const key = `ops-alert:${alertKey}:${bucketStartMs}`
    await this.kv.put(key, "1", { expirationTtl: this.ttlSeconds })
  }
}

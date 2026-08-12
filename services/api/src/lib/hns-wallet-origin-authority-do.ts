import { DurableObject } from "cloudflare:workers"

import type { Env } from "../env"

const STORAGE_KEY_PREFIX = "authority:"
const ROUTING_STORAGE_KEY_PREFIX = "routing:"
const SINGLETON_NAME = "hns-wallet-origin-authority-v1"

export type HnsWalletOriginAuthoritySnapshot = {
  authorityVersion: number
  effective: boolean
  originHostname: string
  reasonCode: "enabled" | "not_registered" | "not_activated" | "hard_denied" | "revoked"
  updatedAt: string
}

/**
 * Request-time projection of the independently governed HNS root routing
 * authority. This is deliberately separate from wallet registration: a root
 * may serve public video/threads without opting into wallet operations.
 */
export type HnsRootRoutingAuthoritySnapshot = {
  authorityVersion: number
  effective: boolean
  originHostname: string
  reasonCode: "enabled" | "not_activated" | "hard_denied" | "expired" | "not_found"
  updatedAt: string
}

export type HnsWalletOriginAuthorityStub = {
  applySnapshot(snapshot: HnsWalletOriginAuthoritySnapshot): Promise<HnsWalletOriginAuthoritySnapshot>
  readSnapshot(rootLabel: string): Promise<HnsWalletOriginAuthoritySnapshot | null>
  applyRoutingSnapshot?(snapshot: HnsRootRoutingAuthoritySnapshot): Promise<HnsRootRoutingAuthoritySnapshot>
  readRoutingSnapshot?(rootLabel: string): Promise<HnsRootRoutingAuthoritySnapshot | null>
}

function rootFromHostname(originHostname: string): string {
  return originHostname.slice("app.".length)
}

function validSnapshot(snapshot: HnsWalletOriginAuthoritySnapshot): boolean {
  return Number.isSafeInteger(snapshot.authorityVersion)
    && snapshot.authorityVersion > 0
    && /^app\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(snapshot.originHostname)
    && Number.isFinite(Date.parse(snapshot.updatedAt))
}

function validRoutingSnapshot(snapshot: HnsRootRoutingAuthoritySnapshot): boolean {
  return Number.isSafeInteger(snapshot.authorityVersion)
    && snapshot.authorityVersion > 0
    && /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(snapshot.originHostname)
    && Number.isFinite(Date.parse(snapshot.updatedAt))
}

/**
 * Singleton durable read projection for request-time wallet authorization.
 * A singleton prevents attacker-controlled Origin headers from fanning out an
 * unbounded number of Durable Object instances. The control-plane row remains
 * the audit source; records inside this object are keyed by normalized root.
 */
export class HnsWalletOriginAuthorityDO extends DurableObject<Env> {
  async readSnapshot(rootLabel: string): Promise<HnsWalletOriginAuthoritySnapshot | null> {
    return await this.ctx.storage.get<HnsWalletOriginAuthoritySnapshot>(
      `${STORAGE_KEY_PREFIX}${rootLabel}`,
    ) ?? null
  }

  async readRoutingSnapshot(rootLabel: string): Promise<HnsRootRoutingAuthoritySnapshot | null> {
    return await this.ctx.storage.get<HnsRootRoutingAuthoritySnapshot>(
      `${ROUTING_STORAGE_KEY_PREFIX}${rootLabel}`,
    ) ?? null
  }

  async applySnapshot(
    snapshot: HnsWalletOriginAuthoritySnapshot,
  ): Promise<HnsWalletOriginAuthoritySnapshot> {
    if (!validSnapshot(snapshot)) {
      throw new Error("invalid_hns_wallet_origin_authority_snapshot")
    }

    const rootLabel = rootFromHostname(snapshot.originHostname)
    const current = await this.readSnapshot(rootLabel)
    if (current && current.authorityVersion > snapshot.authorityVersion) {
      return current
    }
    if (
      current
      && current.authorityVersion === snapshot.authorityVersion
      && JSON.stringify(current) !== JSON.stringify(snapshot)
    ) {
      throw new Error("hns_wallet_origin_authority_version_conflict")
    }

    await this.ctx.storage.put(`${STORAGE_KEY_PREFIX}${rootLabel}`, snapshot)
    return snapshot
  }

  async applyRoutingSnapshot(
    snapshot: HnsRootRoutingAuthoritySnapshot,
  ): Promise<HnsRootRoutingAuthoritySnapshot> {
    if (!validRoutingSnapshot(snapshot)) {
      throw new Error("invalid_hns_root_routing_authority_snapshot")
    }

    const rootLabel = snapshot.originHostname.slice("https://".length)
    const current = await this.readRoutingSnapshot(rootLabel)
    if (current && current.authorityVersion > snapshot.authorityVersion) {
      return current
    }
    if (
      current
      && current.authorityVersion === snapshot.authorityVersion
      && JSON.stringify(current) !== JSON.stringify(snapshot)
    ) {
      // Routing snapshots are a bounded request-time cache. Two workers may
      // refresh the same expired entry concurrently; keep the first writer's
      // equally recent result instead of turning the loser into a CORS outage.
      return current
    }

    await this.ctx.storage.put(`${ROUTING_STORAGE_KEY_PREFIX}${rootLabel}`, snapshot)
    return snapshot
  }
}

export function hnsWalletOriginAuthorityStub(
  env: Pick<Env, "HNS_WALLET_ORIGIN_AUTHORITY"> | undefined,
): HnsWalletOriginAuthorityStub | null {
  return env?.HNS_WALLET_ORIGIN_AUTHORITY?.getByName(SINGLETON_NAME) ?? null
}

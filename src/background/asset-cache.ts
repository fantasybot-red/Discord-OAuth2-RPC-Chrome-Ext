/** Session-only, bounded cache of Discord external asset paths. Keys never contain URLs. */
export const ASSET_CACHE_KEY = 'externalAssetCacheV1'
export const ASSET_CACHE_TTL_MS = 24 * 60 * 60 * 1000
export const ASSET_CACHE_LIMIT = 128

type Entry = { key: string; value: string; expiresAt: number; touchedAt: number }
export interface AssetCacheStorage {
  get(keys: string[]): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
}

function validValue(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 2048 && /^mp:external\/[^\s]+$/.test(value)
}

export class AssetCache {
  private entries = new Map<string, Entry>()
  private loaded: Promise<void> | null = null
  private writes: Promise<void> = Promise.resolve()
  private storage?: AssetCacheStorage
  private now: () => number
  constructor(storage?: AssetCacheStorage, now: () => number = Date.now) {
    this.storage = storage
    this.now = now
  }

  private async key(applicationId: string, url: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url))
    return `${applicationId}:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')}`
  }

  private load(): Promise<void> {
    if (!this.loaded) this.loaded = (async () => {
      try {
        const data = await this.storage?.get([ASSET_CACHE_KEY])
        const items = data?.[ASSET_CACHE_KEY]
        if (!Array.isArray(items)) return
        for (const item of items.slice(0, ASSET_CACHE_LIMIT)) {
          if (item && typeof item === 'object' && typeof item.key === 'string' && /^\d{17,20}:[a-f0-9]{64}$/.test(item.key) && validValue(item.value) && Number.isFinite(item.expiresAt) && item.expiresAt > this.now() && item.expiresAt <= this.now() + ASSET_CACHE_TTL_MS && Number.isFinite(item.touchedAt)) {
            this.entries.set(item.key, { key: item.key, value: item.value, expiresAt: item.expiresAt, touchedAt: item.touchedAt })
          }
        }
      } catch { /* storage is optional */ }
    })()
    return this.loaded
  }

  private persist(): Promise<void> {
    const entries = [...this.entries.values()].map((entry) => ({ ...entry }))
    this.writes = this.writes.then(async () => { await this.storage?.set({ [ASSET_CACHE_KEY]: entries }) }).catch(() => {})
    return this.writes
  }

  async get(applicationId: string, url: string): Promise<string | undefined> {
    await this.load()
    const key = await this.key(applicationId, url)
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key)
      void this.persist()
      return undefined
    }
    entry.touchedAt = this.now()
    this.entries.delete(key)
    this.entries.set(key, entry)
    void this.persist()
    return entry.value
  }

  async set(applicationId: string, url: string, value: string, isCurrent: () => boolean = () => true): Promise<void> {
    if (!validValue(value)) return
    await this.load()
    const key = await this.key(applicationId, url)
    if (!isCurrent()) return
    const now = this.now()
    for (const [k, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(k)
    this.entries.delete(key)
    this.entries.set(key, { key, value, expiresAt: now + ASSET_CACHE_TTL_MS, touchedAt: now })
    while (this.entries.size > ASSET_CACHE_LIMIT) this.entries.delete(this.entries.keys().next().value!)
    await this.persist()
  }
}

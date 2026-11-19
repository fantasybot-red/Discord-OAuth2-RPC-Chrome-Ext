import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AssetCache, ASSET_CACHE_KEY, ASSET_CACHE_LIMIT, ASSET_CACHE_TTL_MS } from '../src/background/asset-cache.ts'

const app = '123456789012345678'
const url = 'https://private.example/image?token=secret'
const value = 'mp:external/hash/image'
class Storage {
  data: Record<string, unknown> = {}
  fail = false
  async get(keys: string[]) { if (this.fail) throw Error(); return Object.fromEntries(keys.map((k) => [k, structuredClone(this.data[k])])) }
  async set(items: Record<string, unknown>) { if (this.fail) throw Error(); Object.assign(this.data, structuredClone(items)) }
}

test('session cache survives worker restart, scopes apps, expires, and hashes URLs', async () => {
  const storage = new Storage()
  let now = 1000
  const cache = new AssetCache(storage, () => now)
  assert.equal(await cache.get(app, url), undefined)
  await cache.set(app, url, value)
  assert.equal(await cache.get(app, url), value)
  assert.equal(await cache.get('223456789012345678', url), undefined)
  const restarted = new AssetCache(storage, () => now)
  assert.equal(await restarted.get(app, url), value)
  const serialized = JSON.stringify(storage.data)
  assert.ok(!serialized.includes(url) && !serialized.includes('secret'))
  now += ASSET_CACHE_TTL_MS
  assert.equal(await restarted.get(app, url), undefined)
})

test('cache is bounded and evicts least recently used', async () => {
  const storage = new Storage()
  const cache = new AssetCache(storage, () => 1000)
  for (let i = 0; i < ASSET_CACHE_LIMIT; i++) await cache.set(app, `https://example.com/${i}`, value)
  await cache.get(app, 'https://example.com/0')
  await cache.set(app, 'https://example.com/new', value)
  assert.equal(await cache.get(app, 'https://example.com/1'), undefined)
  assert.equal(await cache.get(app, 'https://example.com/0'), value)
  assert.equal((storage.data[ASSET_CACHE_KEY] as unknown[]).length, ASSET_CACHE_LIMIT)
})

test('invalid results and stale work are not cached; storage failures fall back to memory', async () => {
  const storage = new Storage()
  storage.fail = true
  const cache = new AssetCache(storage)
  await cache.set(app, url, 'https://invalid.example')
  await cache.set(app, url, value, () => false)
  assert.equal(await cache.get(app, url), undefined)
  await cache.set(app, url, value)
  assert.equal(await cache.get(app, url), value)
})

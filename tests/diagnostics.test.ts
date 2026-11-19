import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEBUG_ENABLED_KEY,
  DIAGNOSTICS_KEY,
  DiagnosticLogger,
  MAX_DIAGNOSTIC_ENTRIES,
  classifyAssetKind,
  classifyAssetKinds,
} from '../src/lib/diagnostics.ts'
import type { DiagnosticAreaLike } from '../src/lib/diagnostics.ts'

class MemArea implements DiagnosticAreaLike {
  data: Record<string, unknown> = {}
  writes: Array<Record<string, unknown>> = []
  fail = false
  delayFirst = false
  async get(keys: string[]) {
    const out: Record<string, unknown> = {}
    for (const k of keys) if (k in this.data) out[k] = structuredClone(this.data[k])
    return out
  }
  async set(items: Record<string, unknown>) {
    if (this.delayFirst && this.writes.length === 0) await new Promise((r) => setTimeout(r, 15))
    if (this.fail) throw new Error('quota')
    this.writes.push(structuredClone(items))
    for (const [k, v] of Object.entries(items)) this.data[k] = structuredClone(v)
  }
}

function make() {
  const local = new MemArea()
  const session = new MemArea()
  let t = 1000
  const logger = new DiagnosticLogger({ local, session, now: () => ++t })
  return { local, session, logger }
}

test('disabled by default records nothing', async () => {
  const { logger, session } = make()
  await logger.init()
  logger.record('auth_started')
  const d = await logger.get()
  assert.equal(d.enabled, false)
  assert.deepEqual(d.entries, [])
  assert.equal(session.writes.length, 0)
})

test('enable, record, ring buffer caps at 100 and keeps newest', async () => {
  const { logger, session, local } = make()
  await logger.setEnabled(true)
  assert.equal(local.data[DEBUG_ENABLED_KEY], true)
  for (let i = 0; i < 130; i++) logger.record('retry_scheduled', { attempt: i, delayMs: 5 })
  const d = await logger.get()
  assert.equal(d.entries.length, MAX_DIAGNOSTIC_ENTRIES)
  assert.equal(d.entries.at(-1)!.details!.attempt, 129)
  assert.equal(d.entries[0]!.details!.attempt, 30)
  assert.equal((session.data[DIAGNOSTICS_KEY] as unknown[]).length, MAX_DIAGNOSTIC_ENTRIES)
  const ids = new Set(d.entries.map((e) => e.id))
  assert.equal(ids.size, d.entries.length)
})

test('clear empties entries; disabling clears and stops recording', async () => {
  const { logger, session, local } = make()
  await logger.setEnabled(true)
  logger.record('auth_started')
  assert.equal((await logger.get()).entries.length > 0, true)
  assert.deepEqual((await logger.clear()).entries, [])
  assert.deepEqual(session.data[DIAGNOSTICS_KEY], [])
  logger.record('auth_started')
  const off = await logger.setEnabled(false)
  assert.equal(off.enabled, false)
  assert.deepEqual(off.entries, [])
  assert.equal(local.data[DEBUG_ENABLED_KEY], false)
  logger.record('auth_started')
  assert.deepEqual((await logger.get()).entries, [])
})

test('idempotent enable keeps entries and does not clear storage', async () => {
  const { logger, session, local } = make()
  await logger.setEnabled(true)
  logger.record('gateway_ready')
  await logger.get()
  const writesBefore = session.writes.length
  const again = await logger.setEnabled(true)
  assert.equal(again.entries.some((e) => e.event === 'gateway_ready'), true)
  assert.equal(session.writes.length, writesBefore)
  assert.equal((session.data[DIAGNOSTICS_KEY] as unknown[]).length, again.entries.length)

  // A fresh worker restores the persisted log and enabling again keeps it.
  const logger2 = new DiagnosticLogger({ local, session })
  const restored = await logger2.get()
  assert.equal(restored.enabled, true)
  assert.equal(restored.entries.length, again.entries.length)
  const re = await logger2.setEnabled(true)
  assert.equal(re.entries.length, again.entries.length)
})

test('drops unknown events, unknown keys and unsafe values', async () => {
  const { logger } = make()
  await logger.setEnabled(true)
  logger.record('not_an_event', { a: 1 })
  logger.record('__proto__')
  logger.record('gateway_closed', {
    code: 4004,
    fatal: true,
    authFailed: 'SECRET-CANARY',
    token: 'SECRET-CANARY',
    url: 'https://example.com/SECRET-CANARY',
  })
  logger.record('refresh_failed', { errorKind: 'Bearer SECRET-CANARY' })
  logger.record('presence_hidden', { reason: 'tab title SECRET-CANARY' })
  logger.record('assets_resolving', { provider: 'discord', count: Number.NaN })
  const d = await logger.get()
  const entries = d.entries.filter((e) => e.event !== 'debug_enabled')
  assert.deepEqual(entries.map((e) => e.event), ['gateway_closed', 'refresh_failed', 'presence_hidden', 'assets_resolving'])
  assert.deepEqual(entries[0]!.details, { code: 4004, fatal: true })
  assert.equal(entries[1]!.details, undefined)
  assert.equal(entries[2]!.details, undefined)
  assert.deepEqual(entries[3]!.details, { provider: 'discord' })
  assert.equal(JSON.stringify(d).includes('SECRET-CANARY'), false)
})

test('persisted entries are re-sanitized on restore', async () => {
  const { local, session } = make()
  local.data[DEBUG_ENABLED_KEY] = true
  session.data[DIAGNOSTICS_KEY] = [
    { id: 'abc-1', time: 5, level: 'error', event: 'gateway_ready', message: 'SECRET-CANARY', details: { x: 'SECRET-CANARY' } },
    { id: 'SECRET-CANARY!', time: 5, event: 'gateway_ready' },
    { id: 'ok-2', time: -1, event: 'gateway_ready' },
    { id: 'ok-3', time: 6, event: 'evil' },
    'junk',
  ]
  const logger = new DiagnosticLogger({ local, session })
  const d = await logger.get()
  assert.equal(d.entries.length, 1)
  assert.equal(d.entries[0]!.level, 'info')
  assert.equal(d.entries[0]!.message, 'Discord connection ready.')
  assert.equal(JSON.stringify(d).includes('SECRET-CANARY'), false)
})

test('snapshots are clones', async () => {
  const { logger } = make()
  await logger.setEnabled(true)
  logger.record('retry_scheduled', { attempt: 1, delayMs: 2 })
  const d = await logger.get()
  d.entries.at(-1)!.details!.attempt = 99
  d.entries.length = 0
  const again = await logger.get()
  assert.equal(again.entries.at(-1)!.details!.attempt, 1)
})

test('writes are serialized in order despite slow first write; storage errors do not throw', async () => {
  const { logger, session } = make()
  await logger.setEnabled(true)
  await logger.get()
  session.writes.length = 0
  session.delayFirst = true
  logger.record('auth_started')
  logger.record('auth_completed')
  logger.record('gateway_ready')
  await logger.get()
  // debug_enabled is entry 1; subsequent writes grow strictly in call order.
  assert.deepEqual(session.writes.map((w) => (w[DIAGNOSTICS_KEY] as unknown[]).length), [2, 3, 4])

  session.fail = true
  logger.record('init')
  const d = await logger.get()
  assert.equal(d.entries.at(-1)!.event, 'init')
})

test('storage read failure at init defaults to disabled', async () => {
  const local = new MemArea()
  local.get = async () => {
    throw new Error('boom')
  }
  const logger = new DiagnosticLogger({ local, session: new MemArea() })
  const d = await logger.get()
  assert.equal(d.enabled, false)
})

test('asset kind classification uses prefixes only', () => {
  assert.equal(classifyAssetKind('mp:external/abc/https/x.com/SECRET'), 'external')
  assert.equal(classifyAssetKind('external/abc'), 'external')
  assert.equal(classifyAssetKind('mp:attachments/1/2/x.png'), 'proxied')
  assert.equal(classifyAssetKind('whatever'), 'unknown')
  assert.equal(classifyAssetKinds([]), 'none')
  assert.equal(classifyAssetKinds(['mp:external/a', 'mp:attachments/b']), 'mixed')
  assert.equal(classifyAssetKinds(['mp:external/a']), 'external')
})

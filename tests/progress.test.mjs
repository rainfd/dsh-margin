import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'dsh-margin-progress-'))
process.env.DSH_MARGIN_PROGRESS = join(dir, 'progress.json')
process.env.DSH_MARGIN_CONFIG = join(dir, 'config.json')

const progress = await import('../lib/progress.js')
const { makeRoutes } = await import('../lib/routes.js')
const { writeConfig } = await import('../lib/store.js')

const INSTANCE = 'https://margin.example'
const base = { instanceUrl: INSTANCE, candidateId: 7, contentVersion: 'v1', ratio: 0.4 }

test('progress keys separate instance and content version', () => {
  const a = progress.progressKey(INSTANCE, 7, 'v1')
  assert.notEqual(a, progress.progressKey('https://other.example', 7, 'v1'))
  assert.notEqual(a, progress.progressKey(INSTANCE, 7, 'v2'))
  assert.notEqual(a, progress.progressKey(INSTANCE, 8, 'v1'))
  assert.equal(a, progress.progressKey(INSTANCE + '/', 7, 'v1'))
})

test('upsert keeps the first-open time, updates position and survives restart', () => {
  progress.clearProgress()
  const first = progress.upsertProgress({ ...base, title: 'T' }, new Date('2026-10-01T00:00:00Z'))
  assert.equal(first.openedAt, '2026-10-01T00:00:00.000Z')
  const second = progress.upsertProgress({ ...base, ratio: 0.9, anchor: 'h2-3' }, new Date('2026-10-02T00:00:00Z'))
  assert.equal(second.openedAt, '2026-10-01T00:00:00.000Z')
  assert.equal(second.updatedAt, '2026-10-02T00:00:00.000Z')
  assert.equal(second.ratio, 0.9)
  assert.equal(second.title, 'T') // retained without resending
  // A new process reads the same file.
  const view = progress.progressView(10, Date.parse('2026-10-02T01:00:00Z'))
  assert.equal(view.total, 1)
  assert.equal(view.entries[0].ratio, 0.9)
})

test('a full scroll is recorded as a ratio and never as read state', () => {
  progress.clearProgress()
  const entry = progress.upsertProgress({ ...base, ratio: 1 })
  assert.equal(entry.ratio, 1)
  assert.equal('read' in entry, false)
  assert.equal('status' in entry, false)
  assert.equal(JSON.stringify(entry).includes('"read"'), false)
})

test('positions for a changed content version are kept separately, not reused', () => {
  progress.clearProgress()
  progress.upsertProgress({ ...base, ratio: 0.2 })
  progress.upsertProgress({ ...base, contentVersion: 'v2', ratio: 0 })
  const view = progress.progressView(10)
  assert.equal(view.total, 2)
  assert.deepEqual(view.entries.map(entry => [entry.contentVersion, entry.ratio]).sort(), [['v1', 0.2], ['v2', 0]])
})

test('entry count is bounded, oldest evicted first', () => {
  progress.clearProgress()
  for (let i = 0; i < progress.MAX_PROGRESS_ENTRIES + 25; i++) {
    const at = new Date(Date.parse('2026-01-01T00:00:00Z') + i * 60_000)
    progress.upsertProgress({ ...base, candidateId: i + 1, ratio: 0.1 }, at)
  }
  const stored = JSON.parse(readFileSync(process.env.DSH_MARGIN_PROGRESS, 'utf8'))
  assert.equal(stored.entries.length, progress.MAX_PROGRESS_ENTRIES)
  // The newest candidate ids survive; the earliest are gone.
  const ids = new Set(stored.entries.map(entry => entry.candidateId))
  assert.equal(ids.has(progress.MAX_PROGRESS_ENTRIES + 25), true)
  assert.equal(ids.has(1), false)
})

test('expired entries are dropped on read; corrupt and foreign files are ignored', () => {
  progress.clearProgress()
  progress.upsertProgress({ ...base }, new Date('2026-01-01T00:00:00Z'))
  const later = Date.parse('2026-01-01T00:00:00Z') + progress.PROGRESS_TTL_MS + 1000
  assert.equal(progress.progressView(10, later).total, 0)
  for (const bad of ['not json', '[]', '{"version":1}', '{"version":1,"entries":[{"bogus":true}]}', 'null']) {
    writeFileSync(process.env.DSH_MARGIN_PROGRESS, bad)
    assert.deepEqual(progress.progressView(10).entries, [], bad)
  }
})

test('a hostile stored file cannot inject fields or escape caps', () => {
  writeFileSync(process.env.DSH_MARGIN_PROGRESS, JSON.stringify({ version: 1, entries: [
    { key: 'x', instanceUrl: INSTANCE, candidateId: 7, contentVersion: 'v1', title: 'x'.repeat(5000), ratio: 42, scrollTop: -5, anchor: 'a'.repeat(1000), openedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', extra: 'DROP' },
    { instanceUrl: INSTANCE, candidateId: -1, contentVersion: 'v1', ratio: 0, openedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    { instanceUrl: INSTANCE, candidateId: 9, contentVersion: 'v1', ratio: 'half', openedAt: 'bad', updatedAt: 'bad' },
  ] }))
  // Evaluate near the stored timestamp: these rows are older than the TTL in
  // real time, and expiry is a separate, already-tested behaviour.
  const entries = progress.progressView(10, Date.parse('2026-01-02T00:00:00Z')).entries
  assert.equal(entries.length, 1)
  assert.equal(entries[0].ratio, 1)
  assert.equal(entries[0].scrollTop, 0)
  assert.equal(entries[0].title.length, 300)
  assert.equal(entries[0].anchor.length, 300)
  assert.equal('extra' in entries[0], false)
})

test('the file is written 0600', { skip: process.platform === 'win32' }, () => {
  progress.clearProgress()
  progress.upsertProgress({ ...base })
  const mode = statSync(process.env.DSH_MARGIN_PROGRESS).mode & 0o777
  assert.equal(mode, 0o600)
})

test('clear removes one row or all rows without touching Margin', () => {
  progress.clearProgress()
  progress.upsertProgress({ ...base })
  progress.upsertProgress({ ...base, candidateId: 8 })
  const key = progress.progressKey(INSTANCE, 7, 'v1')
  assert.equal(progress.clearProgress(key), 1)
  assert.equal(progress.progressView(10).total, 1)
  assert.equal(progress.clearProgress(), 1)
  assert.equal(progress.progressView(10).total, 0)
  assert.equal(existsSync(process.env.DSH_MARGIN_PROGRESS), true)
})

test('routes expose bounded progress with no content-write gate required', async () => {
  progress.clearProgress()
  writeConfig({ baseUrl: INSTANCE, token: 'token', timeoutMs: 1000 })
  const routes = makeRoutes({ requestRejection: () => undefined }, {})
  const call = async (path, body) => {
    const route = routes.find(entry => entry.path === `/api/dsh-margin${path.split('?')[0]}`)
    const req = { method: body === undefined ? 'GET' : 'POST', url: `/api/dsh-margin${path}`, headers: {}, async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) } }
    let status, payload
    const res = { writeHead: value => { status = value }, end: value => { payload = value } }
    route.handler(req, res)
    for (let i = 0; i < 50 && payload === undefined; i++) await new Promise(resolve => setImmediate(resolve))
    return { status, body: payload === undefined ? undefined : JSON.parse(payload) }
  }
  assert.equal((await call('/progress')).status, 200)
  const saved = await call('/progress', { ...base })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.entry.ratio, 0.4)
  const view = await call('/progress')
  assert.equal(view.body.total, 1)
  assert.equal(view.body.maxEntries, progress.MAX_PROGRESS_ENTRIES)
  assert.match(view.body.observedAt, /^\d{4}-\d{2}-\d{2}T/)
  for (const bad of [
    { ...base, ratio: 1.5 }, { ...base, ratio: -0.1 }, { ...base, ratio: 'half' },
    { ...base, contentVersion: '' }, { ...base, candidateId: 0 }, { ...base, instanceUrl: '' },
    { ...base, extra: 1 }, { ...base, title: 'x'.repeat(1001) }, { ...base, anchor: 'x'.repeat(301) },
  ]) assert.equal((await call('/progress', bad)).status, 400, JSON.stringify(bad).slice(0, 60))
  const cleared = await call('/progress-clear', { key: progress.progressKey(INSTANCE, 7, 'v1') })
  assert.equal(cleared.body.removed, 1)
  assert.equal(cleared.body.marginUntouched, true)
  assert.equal((await call('/progress-clear', { key: undefined, extra: 1 })).status, 400)
})

test('progress writes cannot be used to mark articles read on the server', async () => {
  const source = readFileSync(new URL('../src/progressRoutes.ts', import.meta.url), 'utf8')
  // No upstream call path at all: this module has no Margin client import.
  assert.equal(/MarginClient|setCandidateStatus|candidate-status/.test(source), false)
})

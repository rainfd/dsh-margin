import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_MARGIN_CONFIG = join(mkdtempSync(join(tmpdir(), 'dsh-margin-save-')), 'config.json')
const { makeRoutes } = await import('../lib/routes.js')
const { writeConfig } = await import('../lib/store.js')
const { toSaveState } = await import('../lib/saveRoutes.js')

const TOKEN = 'save-secret-token'
const detail = (overrides = {}) => ({
  id: 42, title: 'Article', source_url: 'https://example.com/a', source_type: 'rss', source_domain: 'example.com',
  status: 'unprocessed', summary: 's', tags: [], is_saved_to_trilium: false,
  created_at: '2026-01-01T00:00:00Z', content_md: 'BODY_CANARY', content_text: '', content_fetch_failed: false,
  ...overrides,
})
const receipt = (overrides = {}) => ({
  status: 'success', candidate_id: 42, save_record_id: 7, external_ref: 'note-abc123',
  saved_at: '2026-10-25T10:00:00Z', candidate_status: 'read', message: `saved ${TOKEN}`, ...overrides,
})

async function withHost({ saves = () => ({ status: 200, body: receipt() }), candidate = () => ({ status: 200, body: detail() }), permissions = {}, timeoutMs = 3000, saveDelayMs = 0 }, run) {
  const seen = []
  const upstream = createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const entry = { method: req.method, path: req.url, body: Buffer.concat(chunks).toString('utf8'), headers: req.headers }
      seen.push(entry)
      const isSave = req.url.startsWith('/api/trilium/save')
      const result = isSave ? saves(entry)
        : req.url.startsWith('/api/candidates/42') ? candidate(entry)
          : { status: 404, body: { error: { message: 'no route' } } }
      const send = () => {
        res.writeHead(result.status ?? 200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(result.body))
      }
      if (isSave && saveDelayMs > 0) setTimeout(send, saveDelayMs)
      else send()
    })
  })
  await new Promise(r => upstream.listen(0, '127.0.0.1', r))
  const instanceUrl = `http://127.0.0.1:${upstream.address().port}`
  writeConfig({ baseUrl: instanceUrl, token: TOKEN, timeoutMs })
  const routes = makeRoutes({ requestRejection: () => undefined }, permissions)
  const host = createServer((req, res) => {
    const route = routes.find(r => r.path === req.url.split('?')[0])
    if (!route) { res.writeHead(404); res.end(); return }
    route.handler(req, res)
  })
  await new Promise(r => host.listen(0, '127.0.0.1', r))
  const call = async (path, init) => {
    const response = await fetch(`http://127.0.0.1:${host.address().port}/api/dsh-margin${path}`, init)
    const text = await response.text()
    return { status: response.status, text, body: text === '' ? undefined : JSON.parse(text) }
  }
  const post = (path, body) => call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  try { await run({ call, post, seen, instanceUrl }) } finally {
    await new Promise(r => host.close(r))
    await new Promise(r => upstream.close(r))
  }
}

test('receipt projection keeps only verified identifiers and drops upstream prose', () => {
  const state = toSaveState(receipt(), 42, 'https://m/reader/42')
  assert.deepEqual(state, {
    candidateId: 42, marginUrl: 'https://m/reader/42', saved: true, saveRecordId: 7,
    externalRef: 'note-abc123', savedAt: '2026-10-25T10:00:00Z', needsVerification: false,
  })
  assert.equal(JSON.stringify(state).includes(TOKEN), false)
  // A non-success body must never be reported as saved.
  assert.equal(toSaveState({ status: 'failed', save_record_id: 7 }, 42, 'u').saved, false)
  // Bad identifiers are dropped, not guessed.
  const weak = toSaveState({ status: 'success', save_record_id: 0, external_ref: '', saved_at: 'nope' }, 42, 'u')
  assert.equal(weak.saveRecordId, null)
  assert.equal(weak.externalRef, null)
  assert.equal(weak.savedAt, null)
  assert.throws(() => toSaveState(null, 42, 'u'))
})

test('save is refused by default without touching Margin', async () => {
  await withHost({}, async ({ post, seen, instanceUrl }) => {
    const result = await post('/save-trilium', { candidateId: 42, instanceUrl, marginUrl: `${instanceUrl}/reader/42` })
    assert.equal(result.status, 403)
    assert.equal(result.body.error.code, 'saves_disabled')
    assert.equal(seen.length, 0)
  })
})

test('save-state is read-only and reports the bare durable flag', async () => {
  await withHost({}, async ({ call, instanceUrl }) => {
    const result = await call(`/save-state?id=42&instanceUrl=${encodeURIComponent(instanceUrl)}`)
    assert.equal(result.status, 200)
    assert.equal(result.body.saved, false)
    assert.equal(result.body.saveAllowed, false)
    assert.equal(result.body.saveRecordId, null)
    assert.equal(result.text.includes('BODY_CANARY'), false)
    assert.equal((await call(`/save-state?id=42&instanceUrl=${encodeURIComponent('http://other')}`)).status, 409)
    assert.equal((await call('/save-state?id=0')).status, 400)
  })
})

test('an explicit save forwards exactly one write and reports the record id', async () => {
  await withHost({ permissions: { allowTriliumSave: () => true } }, async ({ post, seen, instanceUrl }) => {
    const result = await post('/save-trilium', { candidateId: 42, instanceUrl, marginUrl: `${instanceUrl}/reader/42` })
    assert.equal(result.status, 200)
    assert.equal(result.body.saved, true)
    assert.equal(result.body.saveRecordId, 7)
    assert.equal(result.body.externalRef, 'note-abc123')
    assert.equal(result.text.includes(TOKEN), false)
    const writes = seen.filter(req => req.method !== 'GET')
    assert.equal(writes.length, 1, 'only the single save may mutate anything')
    assert.equal(writes[0].path, '/api/trilium/save')
    assert.deepEqual(JSON.parse(writes[0].body), { candidate_id: 42 })
    assert.equal(writes[0].headers['x-auth-token'], TOKEN)
  })
})

test('an already-saved article is never written twice', async () => {
  await withHost({
    permissions: { allowTriliumSave: () => true },
    candidate: () => ({ status: 200, body: detail({ is_saved_to_trilium: true }) }),
  }, async ({ post, seen, instanceUrl }) => {
    const result = await post('/save-trilium', { candidateId: 42, instanceUrl, marginUrl: `${instanceUrl}/reader/42` })
    assert.equal(result.status, 409)
    assert.equal(result.body.error.code, 'already_saved')
    assert.equal(seen.filter(req => req.method === 'POST').length, 0)
  })
})

test('instance identity is required and revocations during body read still fail closed', async () => {
  let checks = 0
  await withHost({ permissions: { allowTriliumSave: () => ++checks === 1 } }, async ({ post, seen, instanceUrl }) => {
    const result = await post('/save-trilium', { candidateId: 42, instanceUrl, marginUrl: `${instanceUrl}/reader/42` })
    assert.equal(result.status, 403)
    assert.equal(seen.length, 0)
  })
  await withHost({ permissions: { allowTriliumSave: () => true } }, async ({ post, instanceUrl }) => {
    for (const bad of [
      { candidateId: 42, instanceUrl: 'http://other', marginUrl: 'http://other/reader/42' },
      { candidateId: 42, instanceUrl, marginUrl: `${instanceUrl}/reader/43` },
      { candidateId: 42, instanceUrl },
      { candidateId: 42, instanceUrl, marginUrl: `${instanceUrl}/reader/42`, extra: true },
      { candidateId: 0, instanceUrl, marginUrl: `${instanceUrl}/reader/0` },
      { candidateId: '42', instanceUrl, marginUrl: `${instanceUrl}/reader/42` },
    ]) assert.ok([400, 409].includes((await post('/save-trilium', bad)).status), JSON.stringify(bad))
  })
})

test('failures are classified without relaying note content or tokens', async () => {
  for (const [status, code] of [[404, 'candidate_not_found'], [409, 'save_conflict'], [422, 'trilium_not_configured'], [504, 'trilium_timeout'], [502, 'trilium_save_failed'], [401, 'margin_unauthorized']]) {
    await withHost({
      permissions: { allowTriliumSave: () => true },
      saves: () => ({ status, body: { error: { code: 'x', message: `leak BODY_CANARY ${TOKEN}`, details: { body: 'BODY_CANARY' } } } }),
    }, async ({ post, instanceUrl }) => {
      const result = await post('/save-trilium', { candidateId: 42, instanceUrl, marginUrl: `${instanceUrl}/reader/42` })
      assert.equal(result.status, [401, 404, 409, 422, 504].includes(status) ? status : 502)
      assert.equal(result.body.error.code, code)
      for (const canary of ['BODY_CANARY', TOKEN]) assert.equal(result.text.includes(canary), false, canary)
    })
  }
})

test('an incomplete receipt is reported as unconfirmed, never as success', async () => {
  await withHost({
    permissions: { allowTriliumSave: () => true },
    saves: () => ({ status: 200, body: { status: 'success', candidate_id: 42, message: 'done' } }),
  }, async ({ post, instanceUrl }) => {
    const result = await post('/save-trilium', { candidateId: 42, instanceUrl, marginUrl: `${instanceUrl}/reader/42` })
    assert.equal(result.status, 502)
    assert.equal(result.body.error.code, 'save_unconfirmed')
    assert.equal('saved' in (result.body ?? {}), false)
  })
})

test('a lost save receipt is verified instead of reported as a blind failure', async () => {
  let saved = false
  await withHost({
    permissions: { allowTriliumSave: () => true },
    timeoutMs: 250,
    saveDelayMs: 800,
    saves: () => { saved = true; return { status: 200, body: receipt() } },
    candidate: () => ({ status: 200, body: detail({ is_saved_to_trilium: saved }) }),
  }, async ({ post, instanceUrl }) => {
    const result = await post('/save-trilium', { candidateId: 42, instanceUrl, marginUrl: `${instanceUrl}/reader/42` })
    assert.equal(result.status, 200)
    assert.equal(result.body.saved, true)
    assert.equal(result.body.needsVerification, true)
    assert.equal(result.body.saveRecordId, null)
    assert.equal(result.text.includes(TOKEN), false)
  })
})

test('a timed-out save with no observed write stays uncertain, never a duplicate retry', async () => {
  await withHost({
    permissions: { allowTriliumSave: () => true },
    timeoutMs: 250,
    saveDelayMs: 800,
    candidate: () => ({ status: 200, body: detail({ is_saved_to_trilium: false }) }),
  }, async ({ post, instanceUrl, seen }) => {
    const result = await post('/save-trilium', { candidateId: 42, instanceUrl, marginUrl: `${instanceUrl}/reader/42` })
    assert.equal(result.status, 504)
    assert.equal(result.body.error.code, 'save_unconfirmed')
    assert.match(result.body.error.message, /不确定/)
    assert.equal(seen.filter(req => req.method !== 'GET').length, 1, 'no automatic retry')
  })
})

test('a missing candidate is 404 and no save is attempted', async () => {
  let saves = 0
  await withHost({
    permissions: { allowTriliumSave: () => true },
    candidate: () => ({ status: 404, body: { error: { message: 'gone' } } }),
    saves: () => { saves++; return { status: 200, body: receipt() } },
  }, async ({ post, instanceUrl }) => {
    const result = await post('/save-trilium', { candidateId: 42, instanceUrl, marginUrl: `${instanceUrl}/reader/42` })
    assert.equal(result.status, 404)
    assert.equal(saves, 0)
  })
})

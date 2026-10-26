import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_MARGIN_CONFIG = join(mkdtempSync(join(tmpdir(), 'dsh-margin-management-routes-')), 'config.json')
const { makeRoutes } = await import('../lib/routes.js')
const { writeConfig } = await import('../lib/store.js')

const TOKEN = 'management-secret-token'
const COOKIE = 'SESSION=CANARY_COOKIE_VALUE; other=1'
const FEED = 'https://feeds.example.com/private/rss.xml?token=FEED_SECRET'
const sourceRow = overrides => ({
  id: 12, source_type: 'rss', label: 'Tech feed', status: 'active', poll_interval_minutes: 60,
  consecutive_failures: 0, last_error_at: null, last_error_message: null, latest_entry_title: 'Entry',
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
  config: { feed_url: FEED, last_fetched_at: '2026-10-01T00:00:00Z', last_etag: 'ETAG_SECRET', aggregation: { enabled: true } },
  ...overrides,
})

async function withHost(handler, permissions, run) {
  const seen = []
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString('utf8')
    const entry = { method: req.method, path: req.url, headers: req.headers, body }
    seen.push(entry)
    const result = await handler(entry) ?? { status: 404, body: { error: { message: 'no route' } } }
    res.writeHead(result.status ?? 200, { 'content-type': 'application/json' })
    res.end(result.status === 204 ? undefined : JSON.stringify(result.body))
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const instanceUrl = `http://127.0.0.1:${upstream.address().port}`
  writeConfig({ baseUrl: instanceUrl, token: TOKEN, timeoutMs: 2000 })
  const routes = makeRoutes({ requestRejection: req => req.headers['x-deny'] === 'yes' ? 403 : undefined }, permissions)
  const host = createServer((req, res) => {
    const route = routes.find(r => r.path === req.url.split('?')[0])
    if (!route) { res.writeHead(404); res.end(); return }
    route.handler(req, res)
  })
  await new Promise(resolve => host.listen(0, '127.0.0.1', resolve))
  const call = async (path, init) => {
    const response = await fetch(`http://127.0.0.1:${host.address().port}/api/dsh-margin${path}`, init)
    const text = await response.text()
    return { status: response.status, text, body: text === '' ? undefined : JSON.parse(text) }
  }
  const post = (path, body) => call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  try { await run({ call, post, seen, instanceUrl }) } finally {
    await new Promise(resolve => host.close(resolve))
    await new Promise(resolve => upstream.close(resolve))
  }
}

test('management read succeeds by default, exposes metadata only, and never leaks secrets', async () => {
  await withHost(req => {
    if (req.path === '/api/content-sources') return { body: { items: [sourceRow()] } }
    if (req.path === '/api/domain-credentials') return { body: { items: [{ id: 3, domain: 'zhihu.com', cookie_configured: true, cookie_string: COOKIE, created_at: '2026-01-01T00:00:00Z' }] } }
    if (req.path === '/api/scheduler/status') return { body: { scheduler_running: true, total_active_jobs: 1, jobs: [{ content_source_id: 12, label: 'RSS Poll: Tech feed', next_run_time: '2026-10-25T12:00:00Z', poll_interval_minutes: 60 }] } }
  }, {}, async ({ call }) => {
    const result = await call('/management')
    assert.equal(result.status, 200)
    assert.equal(result.body.instanceUrl.startsWith('http://127.0.0.1:'), true)
    assert.equal(result.body.sourceWritesAllowed, false)
    assert.equal(result.body.credentialWritesAllowed, false)
    assert.equal(result.body.sources[0].feedOrigin, 'https://feeds.example.com')
    assert.equal(result.body.credentials[0].supported, true)
    assert.equal(result.body.scheduler.sourcePollJobs, 1)
    // The label is intended user-facing metadata; everything else here is not.
    assert.equal(result.body.sources[0].label, 'Tech feed')
    for (const canary of [TOKEN, COOKIE, 'CANARY_COOKIE_VALUE', 'FEED_SECRET', 'ETAG_SECRET', 'aggregation', 'Entry', 'RSS Poll']) {
      assert.equal(result.text.includes(canary), false, canary)
    }
  })
})

test('management read failure relays no upstream message, body or detail', async () => {
  for (const [status, fragment] of [[500, '内部错误'], [422, '拒绝'], [401, '凭据'], [404, '不存在']]) {
    await withHost(req => {
      if (req.path === '/api/content-sources') return { status, body: { error: { code: 'x', category: 'c', message: `INSERT INTO creds VALUES ('${COOKIE}')`, details: { validation_errors: COOKIE } } } }
      if (req.path === '/api/domain-credentials') return { body: { items: [] } }
      return { body: { scheduler_running: false, total_active_jobs: 0, jobs: [] } }
    }, {}, async ({ call }) => {
      const result = await call('/management')
      assert.equal(result.status, status === 401 ? 401 : status)
      assert.match(result.body.error.message, new RegExp(fragment))
      for (const canary of [COOKIE, TOKEN, 'INSERT INTO', 'validation_errors']) assert.equal(result.text.includes(canary), false, canary)
    })
  }
})

test('writes are refused by default without contacting Margin', async () => {
  await withHost(() => { throw new Error('must not be called') }, {}, async ({ post, instanceUrl, seen }) => {
    const bodies = [
      ['/source-create', { feedUrl: FEED, label: 'x', intervalMinutes: 60, instanceUrl }],
      ['/source-update', { id: 12, status: 'paused', instanceUrl }],
      ['/source-fetch', { id: 12, instanceUrl }],
      ['/source-delete', { id: 12, confirmOrigin: 'https://feeds.example.com', instanceUrl }],
      ['/credential-create', { domain: 'zhihu.com', cookie: COOKIE, instanceUrl }],
      ['/credential-delete', { id: 3, domain: 'zhihu.com', instanceUrl }],
    ]
    for (const [path, body] of bodies) {
      const result = await post(path, body)
      assert.equal(result.status, 403, path)
      assert.equal(result.body.error.code, 'writes_disabled', path)
      assert.equal(result.text.includes(COOKIE), false, path)
    }
    assert.equal(seen.length, 0)
  })
})

test('source gates are independent and rechecked after the body is read', async () => {
  let sourceChecks = 0
  const permissions = { allowSourceWrites: () => ++sourceChecks === 1 }
  await withHost(req => req.path === '/api/content-sources' ? { status: 201, body: sourceRow() } : {}, permissions, async ({ post, instanceUrl, seen }) => {
    const result = await post('/source-create', { feedUrl: FEED, label: 'Tech', intervalMinutes: 60, instanceUrl })
    assert.equal(result.status, 403) // grant revoked while the body was read
    assert.equal(seen.length, 0)
    assert.equal(sourceChecks, 2)
    // Credential edits are not covered by a source grant.
    assert.equal((await post('/credential-delete', { id: 3, domain: 'zhihu.com', instanceUrl })).status, 403)
  })
})

test('source create validates input, binds the instance and strips secrets from the response', async () => {
  await withHost(req => req.path === '/api/content-sources' ? { status: 201, body: sourceRow() } : {}, { allowSourceWrites: () => true }, async ({ post, instanceUrl, seen }) => {
    const ok = await post('/source-create', { feedUrl: FEED, label: ' Tech ', intervalMinutes: 90, instanceUrl })
    assert.equal(ok.status, 201)
    assert.equal(ok.body.source.feedOrigin, 'https://feeds.example.com')
    assert.equal(ok.text.includes('FEED_SECRET'), false)
    assert.deepEqual(JSON.parse(seen[0].body), { source_type: 'rss', label: 'Tech', poll_interval_minutes: 90, config: { feed_url: FEED } })
    for (const bad of [
      { feedUrl: 'file:///etc/passwd', label: 'x', intervalMinutes: 60, instanceUrl },
      { feedUrl: 'http://127.0.0.1/feed', label: 'x', intervalMinutes: 60, instanceUrl },
      { feedUrl: FEED, label: '   ', intervalMinutes: 60, instanceUrl },
      { feedUrl: FEED, label: 'x'.repeat(121), intervalMinutes: 60, instanceUrl },
      { feedUrl: FEED, label: 'x', intervalMinutes: 4, instanceUrl },
      { feedUrl: FEED, label: 'x', intervalMinutes: 10081, instanceUrl },
      { feedUrl: FEED, label: 'x', intervalMinutes: 1.5, instanceUrl },
      { feedUrl: FEED, label: 'x', intervalMinutes: 60, instanceUrl, config: { feed_url: 'http://evil' } },
    ]) assert.equal((await post('/source-create', bad)).status, 400, JSON.stringify(bad))
    assert.equal((await post('/source-create', { feedUrl: FEED, label: 'x', intervalMinutes: 60, instanceUrl: 'http://other' })).status, 409)
    assert.equal(seen.length, 1)
  })
})

test('source status, fetch and delete require confirmation against live state', async () => {
  let rows = [sourceRow()]
  await withHost(req => {
    if (req.path === '/api/content-sources' && req.method === 'GET') return { body: { items: rows } }
    if (req.path === '/api/content-sources/12' && req.method === 'PATCH') return { body: sourceRow({ status: 'paused' }) }
    if (req.path === '/api/content-sources/12' && req.method === 'DELETE') return { status: 204 }
    if (req.path === '/api/content-sources/12/fetch') return { body: { content_source_id: 12, new_candidates_count: 0, message: 'done' } }
  }, { allowSourceWrites: () => true }, async ({ post, instanceUrl, seen }) => {
    const paused = await post('/source-update', { id: 12, status: 'paused', instanceUrl })
    assert.equal(paused.status, 200)
    assert.equal(paused.body.source.status, 'paused')
    assert.deepEqual(JSON.parse(seen.at(-1).body), { status: 'paused' }) // never label/config
    assert.equal((await post('/source-update', { id: 12, status: 'error', instanceUrl })).status, 400)
    const fetched = await post('/source-fetch', { id: 12, instanceUrl })
    assert.equal(fetched.status, 200)
    assert.equal(fetched.body.newCandidates, 0)
    assert.match(fetched.body.message, /请求抓取|后续/)
    assert.equal((await post('/source-delete', { id: 12, confirmOrigin: '', instanceUrl })).status, 400)
    assert.equal((await post('/source-delete', { id: 12, confirmOrigin: 'https://other.example', instanceUrl })).status, 409)
    assert.equal((await post('/source-delete', { id: 12, confirmOrigin: 'https://feeds.example.com', instanceUrl })).body.articlesRetained, true)
    const deletes = seen.filter(req => req.method === 'DELETE')
    assert.equal(deletes.length, 1)
    rows = []
  })
})

test('credential writes are gated separately, restricted to consumed domains, and never echo the cookie', async () => {
  await withHost(req => {
    if (req.path === '/api/domain-credentials' && req.method === 'GET') return { body: { items: [{ id: 4, domain: 'zhihu.com', cookie_configured: true }] } }
    // Hostile upstream: the cookie is echoed in `domain`; the route must ignore it.
    if (req.path === '/api/domain-credentials' && req.method === 'POST') return { status: 201, body: { id: 5, domain: COOKIE, cookie_configured: true } }
    if (req.path === '/api/domain-credentials/4' && req.method === 'DELETE') return { status: 204 }
  }, { allowCredentialWrites: () => true, allowSourceWrites: () => false }, async ({ post, instanceUrl, seen }) => {
    assert.equal((await post('/source-update', { id: 12, status: 'paused', instanceUrl })).status, 403)
    for (const domain of ['bilibili.com', 'other.example', 'https://zhihu.com', 'zhihu.com:443', '']) {
      assert.equal((await post('/credential-create', { domain, cookie: COOKIE, instanceUrl })).status, 400, domain)
    }
    for (const cookie of ['', 'no-equals', 'a=1\u0000']) {
      assert.equal((await post('/credential-create', { domain: 'zhihu.com', cookie, instanceUrl })).status, 400, cookie)
    }
    const ok = await post('/credential-create', { domain: ' ZHIHU.com ', cookie: COOKIE, instanceUrl })
    assert.equal(ok.status, 201)
    assert.equal(ok.body.credential.domain, 'zhihu.com', 'the validated request domain wins, not the upstream echo')
    assert.equal(ok.text.includes('CANARY_COOKIE_VALUE'), false)
    assert.equal(ok.text.includes('other=1'), false)
    assert.equal(JSON.parse(seen.find(req => req.method === 'POST').body).cookie_string, COOKIE) // forwarded once, upstream only
    assert.equal((await post('/credential-delete', { id: 4, domain: 'mp.weixin.qq.com', instanceUrl })).status, 404)
    assert.equal((await post('/credential-delete', { id: 4, domain: 'zhihu.com', instanceUrl })).status, 200)
  })
})

test('a credential 422 body that echoes the secret is never relayed', async () => {
  await withHost(req => {
    if (req.path === '/api/domain-credentials' && req.method === 'POST') {
      return { status: 422, body: { detail: { validation_errors: [{ cookie_string: 'session=CANARY_COOKIE_VALUE' }] }, message: 'session=CANARY_COOKIE_VALUE' } }
    }
  }, { allowCredentialWrites: () => true }, async ({ post, instanceUrl }) => {
    const result = await post('/credential-create', { domain: 'zhihu.com', cookie: 'session=CANARY_COOKIE_VALUE', instanceUrl })
    assert.equal(result.status, 422)
    assert.equal(result.text.includes('CANARY_COOKIE_VALUE'), false)
    assert.match(result.body.error.message, /拒绝/)
  })
})

test('management paths honour the DSH session gate and method restrictions', async () => {
  await withHost(() => ({ body: { items: [] } }), {}, async ({ call }) => {
    assert.equal((await call('/management', { headers: { 'x-deny': 'yes' } })).status, 403)
    for (const path of ['/source-create', '/source-update', '/source-fetch', '/source-delete', '/credential-create', '/credential-delete']) {
      assert.equal((await call(path)).status, 405, path)
    }
    assert.equal((await call('/management', { method: 'POST' })).status, 405)
  })
})

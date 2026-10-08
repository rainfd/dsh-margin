/**
 * Route tests: the /api/dsh-margin family, driven through makeRoutes() with a
 * fake Margin behind it.
 *
 * These assert the two things that would be a security or data problem in
 * production: a non-loopback caller must be refused (403) on every route, and
 * the token must never appear in any response body.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'dsh-margin-routes-'))
process.env.DSH_MARGIN_CONFIG = join(dir, 'dsh-margin.json')

const TOKEN = 'super-secret-token-value'
const routes = (await import('../lib/routes.js')).makeRoutes()
const store = await import('../lib/store.js')

store.writeConfig({ baseUrl: 'http://127.0.0.1:1', token: TOKEN, timeoutMs: 1000 })

/** A candidate as the fake Margin serves it. */
function row(overrides = {}) {
  return {
    id: 865,
    title: '样本文章',
    source_url: 'https://example.com/a',
    source_domain: 'example.com',
    status: 'unprocessed',
    source_type: 'rss',
    category: null,
    tags: [],
    author: null,
    summary: '摘录',
    summary_text: '摘要',
    is_saved_to_trilium: false,
    created_at: '2026-10-07T08:43:50',
    updated_at: '2026-10-07T08:44:03',
    ...overrides,
  }
}

/**
 * Start a fake Margin and mount the plugin's routes on a local server, so
 * requests take the real socket path (and therefore the real remoteAddress).
 */
async function withRoutes(marginHandler, run) {
  const margin = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const result = marginHandler(url)
    res.writeHead(result.status ?? 200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(result.body ?? {}))
  })
  await new Promise(resolve => margin.listen(0, '127.0.0.1', resolve))
  const marginPort = margin.address().port

  const host = createServer((req, res) => {
    const route = routes.find(candidate => req.url.split('?')[0] === candidate.path)
    if (route === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    void route.handler(req, res)
  })
  await new Promise(resolve => host.listen(0, '127.0.0.1', resolve))
  const hostPort = host.address().port

  const call = async (path, init) => {
    const response = await fetch(`http://127.0.0.1:${hostPort}${path}`, init)
    const text = await response.text()
    return { status: response.status, body: text === '' ? null : JSON.parse(text) }
  }

  try {
    await run({ call, marginPort, hostPort })
  } finally {
    await new Promise(resolve => host.close(resolve))
    await new Promise(resolve => margin.close(resolve))
  }
}

test('GET /config 只返回 baseUrl/tokenSet/timeoutMs', async () => {
  await withRoutes(
    () => ({ body: {} }),
    async ({ call }) => {
      const result = await call('/api/dsh-margin/config')
      assert.equal(result.status, 200)
      assert.deepEqual(Object.keys(result.body).sort(), ['baseUrl', 'timeoutMs', 'tokenSet'])
      assert.equal(result.body.tokenSet, true)
    },
  )
})

test('配置响应里不出现 token 明文', async () => {
  await withRoutes(
    () => ({ body: {} }),
    async ({ call }) => {
      const result = await call('/api/dsh-margin/config')
      assert.equal(JSON.stringify(result.body).includes(TOKEN), false)
      assert.equal(result.body.tokenSet, true, '应只报告「已设置」而不返回值')
    },
  )
})

test('PUT /config 拒绝非法 baseUrl 并保留原配置', async () => {
  await withRoutes(
    () => ({ body: {} }),
    async ({ call }) => {
      const before = store.readConfig()
      const bad = await call('/api/dsh-margin/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseUrl: 'ftp://nope' }),
      })
      assert.equal(bad.status, 400)
      assert.equal(bad.body.error.code, 'invalid_config')
      assert.deepEqual(store.readConfig(), before, '非法补丁不得改动磁盘配置')
    },
  )
})

test('PUT /config 接受合法补丁并且不返回 token', async () => {
  await withRoutes(
    () => ({ body: {} }),
    async ({ call }) => {
      const ok = await call('/api/dsh-margin/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 2000 }),
      })
      assert.equal(ok.status, 200)
      assert.equal(ok.body.timeoutMs, 2000)
      assert.equal(JSON.stringify(ok.body).includes(TOKEN), false)
      assert.equal(store.readConfig().token, TOKEN, '省略 token 时原 token 必须保留')
    },
  )
})

test('GET /candidates 返回待读视图与来源分布', async () => {
  await withRoutes(
    url => ({
      body: {
        items: [row({ id: 1, source_type: 'rss' }), row({ id: 2, source_type: 'wechat' })],
        pagination: { page: 1, page_size: 100, total: 88, total_pages: 1 },
      },
    }),
    async ({ call, marginPort }) => {
      store.writeConfig({ baseUrl: `http://127.0.0.1:${marginPort}`, token: TOKEN, timeoutMs: 3000 })
      const result = await call('/api/dsh-margin/candidates?limit=10')
      assert.equal(result.status, 200)
      assert.equal(result.body.total, 88)
      assert.equal(result.body.items.length, 2)
      assert.equal(result.body.applied.status, 'unprocessed')
      assert.deepEqual(result.body.breakdown.map(b => b.sourceType).sort(), ['rss', 'wechat'])
    },
  )
})

test('GET /candidates 未配置时返回 409 not_configured', async () => {
  await withRoutes(
    () => ({ body: {} }),
    async ({ call }) => {
      store.writeConfig({ baseUrl: 'http://127.0.0.1:1', token: '', timeoutMs: 1000 })
      const result = await call('/api/dsh-margin/candidates')
      assert.equal(result.status, 409)
      assert.equal(result.body.error.code, 'not_configured')
    },
  )
})

test('Margin 401 透传为 401 margin_unauthorized', async () => {
  await withRoutes(
    () => ({ status: 401, body: { error: { message: '未授权' } } }),
    async ({ call, marginPort }) => {
      store.writeConfig({ baseUrl: `http://127.0.0.1:${marginPort}`, token: TOKEN, timeoutMs: 3000 })
      const result = await call('/api/dsh-margin/candidates')
      assert.equal(result.status, 401)
      assert.equal(result.body.error.code, 'margin_unauthorized')
      assert.equal(JSON.stringify(result.body).includes(TOKEN), false)
    },
  )
})

test('GET /candidate 校验 id 并映射 404', async () => {
  await withRoutes(
    url => url.pathname === '/api/candidates/999'
      ? { status: 404, body: { error: { message: '不存在' } } }
      : { body: row({ id: Number(url.pathname.split('/').pop()) }) },
    async ({ call, marginPort }) => {
      store.writeConfig({ baseUrl: `http://127.0.0.1:${marginPort}`, token: TOKEN, timeoutMs: 3000 })
      const bad = await call('/api/dsh-margin/candidate?id=abc')
      assert.equal(bad.status, 400)
      assert.equal(bad.body.error.code, 'invalid_id')

      const missing = await call('/api/dsh-margin/candidate?id=999')
      assert.equal(missing.status, 404)

      const found = await call('/api/dsh-margin/candidate?id=865')
      assert.equal(found.status, 200)
      assert.equal(found.body.id, 865)
    },
  )
})

test('POST /test 在凭据被拒时返回 ok:false 而不是抛错', async () => {
  await withRoutes(
    () => ({ status: 401, body: { error: { message: '未授权' } } }),
    async ({ call, marginPort }) => {
      store.writeConfig({ baseUrl: `http://127.0.0.1:${marginPort}`, token: TOKEN, timeoutMs: 3000 })
      const result = await call('/api/dsh-margin/test', { method: 'POST' })
      assert.equal(result.status, 200)
      assert.equal(result.body.ok, false)
      assert.match(result.body.detail, /拒绝凭据/)
    },
  )
})

test('POST /test 在连接正常时返回计数', async () => {
  await withRoutes(
    url => ({ body: { items: [], pagination: { total: url.searchParams.get('status') === 'read' ? 144 : 88 } } }),
    async ({ call, marginPort }) => {
      store.writeConfig({ baseUrl: `http://127.0.0.1:${marginPort}`, token: TOKEN, timeoutMs: 3000 })
      const result = await call('/api/dsh-margin/test', { method: 'POST' })
      assert.equal(result.body.ok, true)
      assert.deepEqual(result.body.counts, { unprocessed: 88, read: 144 })
    },
  )
})

test('未知方法返回 405', async () => {
  await withRoutes(
    () => ({ body: {} }),
    async ({ call }) => {
      const result = await call('/api/dsh-margin/candidates', { method: 'DELETE' })
      assert.equal(result.status, 405)
    },
  )
})

test('path 与已注册路由精确匹配（kind=exact）', () => {
  const paths = routes.map(route => route.path).sort()
  assert.deepEqual(paths, [
    '/api/dsh-margin/candidate',
    '/api/dsh-margin/candidates',
    '/api/dsh-margin/config',
    '/api/dsh-margin/test',
  ])
  assert.equal(routes.every(route => route.kind === 'exact'), true)
})

test('非 loopback 来源被拒绝（cross-site）对所有路由生效', async () => {
  await withRoutes(
    () => ({ body: {} }),
    async ({ hostPort }) => {
      const cases = [
        ['GET', '/api/dsh-margin/config'],
        ['PUT', '/api/dsh-margin/config'],
        ['POST', '/api/dsh-margin/test'],
        ['GET', '/api/dsh-margin/candidates'],
        ['GET', '/api/dsh-margin/candidate?id=1'],
      ]
      for (const [method, path] of cases) {
        const response = await fetch(`http://127.0.0.1:${hostPort}${path}`, {
          method,
          headers: {
            'sec-fetch-site': 'cross-site',
            'content-type': 'application/json',
          },
          ...(method === 'PUT' || method === 'POST' ? { body: '{}' } : {}),
        })
        const body = await response.json()
        assert.equal(response.status, 403, `${method} ${path} 应为 403`)
        assert.equal(body.error.message, 'forbidden: loopback-only')
      }
    },
  )
})

test('跨源 Origin 被拒绝', async () => {
  await withRoutes(
    () => ({ body: {} }),
    async ({ hostPort }) => {
      const response = await fetch(`http://127.0.0.1:${hostPort}/api/dsh-margin/config`, {
        headers: { origin: 'http://evil.example.com' },
      })
      assert.equal(response.status, 403)
    },
  )
})

test('同源 Origin 被接受', async () => {
  await withRoutes(
    () => ({ body: {} }),
    async ({ call, hostPort }) => {
      const response = await fetch(`http://127.0.0.1:${hostPort}/api/dsh-margin/config`, {
        headers: { origin: `http://127.0.0.1:${hostPort}` },
      })
      assert.equal(response.status, 200)
      void call
    },
  )
})

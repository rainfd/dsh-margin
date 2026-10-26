/**
 * Route tests: the /api/dsh-margin family, driven through makeRoutes() with a
 * fake Margin behind it.
 *
 * These assert the security boundary: every exact route delegates admission
 * to DSH Connection, rejects untrusted requests, and never returns the Margin token.
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
const store = await import('../lib/store.js')
const { makeRoutes } = await import('../lib/routes.js')
const connection = {
  requestRejection(req) {
    if (req.headers['x-test-reject'] === '401') return 401
    if (req.headers['x-test-reject'] === '403' || req.headers['sec-fetch-site'] === 'cross-site') return 403
    const origin = req.headers.origin
    const host = req.headers.host
    if (origin !== undefined && host !== undefined && new URL(origin).host !== host) return 403
    return undefined
  },
}
const routes = makeRoutes(connection)

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
async function withRoutes(marginHandler, run, permissions = {}) {
  const activeRoutes = makeRoutes(connection, permissions)
  const margin = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const result = await marginHandler(url, req)
    res.writeHead(result.status ?? 200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(result.body ?? {}))
  })
  await new Promise(resolve => margin.listen(0, '127.0.0.1', resolve))
  const marginPort = margin.address().port

  const host = createServer((req, res) => {
    const route = activeRoutes.find(candidate => req.url.split('?')[0] === candidate.path)
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
        pagination: { page: 1, page_size: 100, total: 2, total_pages: 1 },
      },
    }),
    async ({ call, marginPort }) => {
      store.writeConfig({ baseUrl: `http://127.0.0.1:${marginPort}`, token: TOKEN, timeoutMs: 3000 })
      const result = await call('/api/dsh-margin/candidates?limit=10')
      assert.equal(result.status, 200)
      assert.equal(result.body.total, 2)
      assert.equal(result.body.totalExact, true)
      assert.equal(result.body.writesAllowed, false)
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

test('GET /candidate 返回正文，列表不带正文，HTML 与 token 不出边界', async () => {
  const body = row({ content_md: '# 正文', content_text: '正文', content_fetch_failed: true, content_html: '<script>bad()</script>' })
  await withRoutes(
    url => ({ body: url.pathname === '/api/candidates/865' ? body : { items: [body], pagination: { page: 1, page_size: 100, total: 1, total_pages: 1 } } }),
    async ({ call, marginPort }) => {
      store.writeConfig({ baseUrl: `http://127.0.0.1:${marginPort}`, token: TOKEN, timeoutMs: 1000 })
      const detail = await call('/api/dsh-margin/candidate?id=865')
      assert.equal(detail.status, 200)
      assert.equal(detail.body.contentMd, '# 正文')
      assert.equal(detail.body.contentText, '正文')
      assert.equal(detail.body.contentFetchFailed, true)
      assert.equal(JSON.stringify(detail.body).includes(TOKEN), false)
      assert.equal('content_html' in detail.body, false)
      const list = await call('/api/dsh-margin/candidates')
      assert.equal(list.status, 200)
      assert.equal('contentMd' in list.body.items[0], false)
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
    '/api/dsh-margin/ai-capability',
    '/api/dsh-margin/ai-run',
    '/api/dsh-margin/annotations',
    '/api/dsh-margin/candidate',
    '/api/dsh-margin/candidate-status',
    '/api/dsh-margin/candidates',
    '/api/dsh-margin/config',
    '/api/dsh-margin/credential-create',
    '/api/dsh-margin/credential-delete',
    '/api/dsh-margin/highlight-create',
    '/api/dsh-margin/highlight-delete',
    '/api/dsh-margin/highlight-link',
    '/api/dsh-margin/import-pdf',
    '/api/dsh-margin/import-task',
    '/api/dsh-margin/import-url',
    '/api/dsh-margin/imports',
    '/api/dsh-margin/management',
    '/api/dsh-margin/note-create',
    '/api/dsh-margin/note-delete',
    '/api/dsh-margin/note-update',
    '/api/dsh-margin/progress',
    '/api/dsh-margin/progress-clear',
    '/api/dsh-margin/save-state',
    '/api/dsh-margin/save-trilium',
    '/api/dsh-margin/source-create',
    '/api/dsh-margin/source-delete',
    '/api/dsh-margin/source-fetch',
    '/api/dsh-margin/source-update',
    '/api/dsh-margin/test',
  ])
  assert.equal(routes.every(route => route.kind === 'exact'), true)
})

test('所有精确路由都委托 DSH Connection 拒绝跨站请求', async () => {
  await withRoutes(
    () => ({ body: {} }),
    async ({ hostPort }) => {
      const cases = [
        ['GET', '/api/dsh-margin/config'],
        ['PUT', '/api/dsh-margin/config'],
        ['POST', '/api/dsh-margin/test'],
        ['GET', '/api/dsh-margin/candidates'],
        ['GET', '/api/dsh-margin/candidate?id=1'],
        ['PATCH', '/api/dsh-margin/candidate-status'],
        ['GET', '/api/dsh-margin/management'],
        ['POST', '/api/dsh-margin/source-create'],
        ['POST', '/api/dsh-margin/credential-create'],
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
        assert.equal(body.error, 'forbidden: same-origin request required')
      }
    },
  )
})

test('所有精确路由都透传 DSH Connection 的未登录状态', async () => {
  await withRoutes(
    () => ({ body: {} }),
    async ({ hostPort }) => {
      for (const path of [
        '/api/dsh-margin/config', '/api/dsh-margin/test',
        '/api/dsh-margin/candidates', '/api/dsh-margin/candidate?id=1', '/api/dsh-margin/candidate-status',
      ]) {
        const response = await fetch(`http://127.0.0.1:${hostPort}${path}`, {
          headers: { 'x-test-reject': '401' },
        })
        assert.equal(response.status, 401, path)
        assert.equal((await response.json()).error, 'unauthorized')
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

test('状态写路径默认拒绝且不触发任何上游请求', async () => {
  let requests = 0
  await withRoutes(() => { requests++; return { body: {} } }, async ({ call }) => {
    const result = await call('/api/dsh-margin/candidate-status', { method: 'PATCH', body: '{}' })
    assert.equal(result.status, 403)
    assert.equal(result.body.error.code, 'writes_disabled')
    assert.equal(requests, 0)
  })
})

test('状态写入显式、幂等、返回部分确认；权限撤销立即生效', async () => {
  let allowed = true
  const seen = []
  await withRoutes(async (url, req) => {
    let text = ''; for await (const chunk of req) text += chunk
    const body = JSON.parse(text)
    seen.push({ path: url.pathname, method: req.method, body })
    return { body: { id: 865, status: body.status, is_saved_to_trilium: false, updated_at: 'now' } }
  }, async ({ call, marginPort }) => {
    const baseUrl = `http://127.0.0.1:${marginPort}`
    store.writeConfig({ baseUrl, token: TOKEN, timeoutMs: 1000 })
    const write = status => call('/api/dsh-margin/candidate-status', {
      method: 'PATCH', body: JSON.stringify({ id: 865, status, marginUrl: `${baseUrl}/reader/865` }),
    })
    for (const status of ['read', 'read', 'unprocessed']) {
      const result = await write(status)
      assert.equal(result.status, 200)
      assert.deepEqual(result.body, { id: 865, status, isSavedToTrilium: false, updatedAt: 'now' })
      assert.equal('title' in result.body, false)
      assert.equal(JSON.stringify(result.body).includes(TOKEN), false)
    }
    assert.deepEqual(seen.map(r => r.body.status), ['read', 'read', 'unprocessed'])
    assert.ok(seen.every(r => r.path === '/api/candidates/865/status' && r.method === 'PATCH'))
    allowed = false
    assert.equal((await write('read')).status, 403)
    assert.equal(seen.length, 3)
  }, { allowWrites: () => allowed })
})

test('非法目标、ID、实例或请求体在写入前拒绝', async () => {
  let requests = 0
  await withRoutes(() => { requests++; return { body: {} } }, async ({ call, marginPort }) => {
    const baseUrl = `http://127.0.0.1:${marginPort}`
    store.writeConfig({ baseUrl, token: TOKEN, timeoutMs: 1000 })
    const valid = { id: 865, status: 'read', marginUrl: `${baseUrl}/reader/865` }
    for (const body of [null, [], {}, { ...valid, id: '865' }, { ...valid, id: 0 }, { ...valid, id: 1.5 }, { ...valid, status: 'error' }, { ...valid, status: 'processing' }, { ...valid, extra: true }]) {
      assert.equal((await call('/api/dsh-margin/candidate-status', { method: 'PATCH', body: JSON.stringify(body) })).status, 400)
    }
    assert.equal((await call('/api/dsh-margin/candidate-status', { method: 'PATCH', body: '{bad' })).status, 400)
    assert.equal((await call('/api/dsh-margin/candidate-status', { method: 'PATCH', body: JSON.stringify({ ...valid, marginUrl: 'http://other/reader/865' }) })).status, 409)
    assert.equal((await call('/api/dsh-margin/candidate-status')).status, 405)
    assert.equal(requests, 0)
  }, { allowWrites: () => true })
})

test('读请求返回实时写权限；分页参数/状态校验生效', async () => {
  let allowed = true
  await withRoutes(() => ({ body: { items: [row()], pagination: { page: 1, page_size: 100, total: 1, total_pages: 1 } } }), async ({ call, marginPort }) => {
    store.writeConfig({ baseUrl: `http://127.0.0.1:${marginPort}`, token: TOKEN, timeoutMs: 1000 })
    assert.equal((await call('/api/dsh-margin/candidates')).body.writesAllowed, true)
    allowed = false
    assert.equal((await call('/api/dsh-margin/candidates')).body.writesAllowed, false)
    assert.equal((await call('/api/dsh-margin/candidates?page=1.5')).status, 400)
    assert.equal((await call('/api/dsh-margin/candidates?status=bad')).status, 400)
    const clamped = await call('/api/dsh-margin/candidates?page=99&limit=1')
    assert.equal(clamped.body.page, 1)
  }, { allowWrites: () => allowed })
})

test('写权限在读完请求体后再次检查', async () => {
  let requests = 0, checks = 0
  await withRoutes(() => { requests++; return { body: {} } }, async ({ call, marginPort }) => {
    const baseUrl = `http://127.0.0.1:${marginPort}`
    store.writeConfig({ baseUrl, token: TOKEN, timeoutMs: 1000 })
    const result = await call('/api/dsh-margin/candidate-status', { method: 'PATCH', body: JSON.stringify({ id: 865, status: 'read', marginUrl: `${baseUrl}/reader/865` }) })
    assert.equal(result.status, 403)
    assert.equal(checks, 2)
    assert.equal(requests, 0)
  }, { allowWrites: () => ++checks === 1 })
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

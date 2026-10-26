/**
 * Margin client tests against a local HTTP server standing in for Margin.
 *
 * The behaviours under test are the ones that would silently corrupt data or
 * leak a credential in production: auth mapping, error-envelope mapping,
 * paging, client-side filtering, 404 handling and token confinement.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

const { MarginClient, MarginAuthError, MarginRequestError, MarginShapeError } = await import('../lib/margin.js')

/** A row shaped like Margin's own candidate payload. */
function row(overrides = {}) {
  return {
    id: 865,
    title: '样本文章',
    source_url: 'https://example.com/a',
    source_domain: 'example.com',
    status: 'unprocessed',
    source_type: 'rss',
    category: '技术分析',
    tags: ['CUDA'],
    author: null,
    summary: '正文摘录',
    summary_text: 'AI 摘要',
    is_saved_to_trilium: false,
    created_at: '2026-10-07T08:43:50',
    updated_at: '2026-10-07T08:44:03',
    ...overrides,
  }
}

/**
 * Start a fake Margin. `handler` receives (url, req) and returns
 * {status, body}; the recorded requests are exposed for assertions.
 */
async function withServer(handler, run) {
  const seen = []
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    seen.push({ path: url.pathname, search: url.searchParams, headers: req.headers })
    const result = handler(url, req)
    res.writeHead(result.status ?? 200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(result.body ?? {}))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const makeClient = options => new MarginClient({ baseUrl: `http://127.0.0.1:${port}`, token: 'secret-token', timeoutMs: 3000, ...options })
    await run({ port, seen, client: makeClient })
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

test('列表按 status/page_size 传参并解析分页', async () => {
  await withServer(
    () => ({ body: { items: [row()], pagination: { page: 1, page_size: 100, total: 88, total_pages: 1 } } }),
    async ({ client, seen }) => {
      const page = await client().listCandidates({ status: 'unprocessed' })
      assert.equal(seen[0].search.get('status'), 'unprocessed')
      assert.equal(seen[0].search.get('page_size'), '100')
      assert.equal(page.total, 88)
      assert.equal(page.items.length, 1)
      assert.equal(page.items[0].title, '样本文章')
    },
  )
})

test('待读链接指向当前 Margin reader，保留原文且不含凭据', async () => {
  await withServer(
    () => ({ body: { items: [row(), row({ id: 866, source_url: '' })], pagination: { total: 2 } } }),
    async ({ client, port }) => {
      const page = await client({ baseUrl: `http://127.0.0.1:${port}///` }).listCandidates()
      assert.equal(page.items[0].marginUrl, `http://127.0.0.1:${port}/reader/865`)
      assert.equal(page.items[0].sourceUrl, 'https://example.com/a')
      assert.equal(page.items[1].marginUrl, `http://127.0.0.1:${port}/reader/866`)
      assert.equal(JSON.stringify(page).includes('secret-token'), false)
    },
  )
})

test('详情链接使用所属实例地址，不混用其他实例', async () => {
  await withServer(
    () => ({ body: row() }),
    async ({ client, port }) => {
      const candidate = await client().getCandidate(865)
      assert.equal(candidate.marginUrl, `http://127.0.0.1:${port}/reader/865`)
    },
  )
})

test('详情保留 Markdown/纯文本及提取失败标记，不暴露 HTML', async () => {
  await withServer(
    () => ({ body: row({ content_md: '# 正文\n\n![图](https://example.com/a.png)', content_text: '正文', content_html: '<script>bad()</script>', content_fetch_failed: true }) }),
    async ({ client }) => {
      const detail = await client().getCandidate(865)
      assert.equal(detail.contentMd, '# 正文\n\n![图](https://example.com/a.png)')
      assert.equal(detail.contentText, '正文')
      assert.equal(detail.contentFetchFailed, true)
      assert.equal('content_html' in detail, false)
      assert.equal(JSON.stringify(detail).includes('secret-token'), false)
    },
  )
})

test('缺失/null/异常类型的正文字段安全降级，不用摘要冒充全文', async () => {
  for (const fields of [{}, { content_md: null, content_text: null }, { content_md: {}, content_text: 42, content_fetch_failed: 'true' }]) {
    await withServer(
      () => ({ body: row(fields) }),
      async ({ client }) => {
        const detail = await client().getCandidate(865)
        assert.equal(detail.contentMd, '')
        assert.equal(detail.contentText, '')
        assert.equal(detail.contentFetchFailed, false)
        assert.equal(detail.summaryText, 'AI 摘要')
      },
    )
  }
})

test('列表即使上游附带全文也不保留正文', async () => {
  await withServer(
    () => ({ body: { items: [row({ content_md: 'full body', content_text: 'full body', content_html: '<p>full body</p>' })], pagination: { total: 1 } } }),
    async ({ client }) => {
      const { items } = await client().listCandidates()
      assert.equal('contentMd' in items[0], false)
      assert.equal('contentText' in items[0], false)
      assert.equal(JSON.stringify(items).includes('full body'), false)
    },
  )
})

test('凭据以 X-Auth-Token 发送', async () => {
  await withServer(
    () => ({ body: { items: [], pagination: { total: 0 } } }),
    async ({ client, seen }) => {
      await client().listCandidates()
      assert.equal(seen[0].headers['x-auth-token'], 'secret-token')
    },
  )
})

test('401 映射为 MarginAuthError，且错误信息不含 token', async () => {
  await withServer(
    () => ({ status: 401, body: { error: { code: 'unauthorized', category: 'auth_error', message: '未授权' } } }),
    async ({ client }) => {
      await assert.rejects(() => client().listCandidates(), error => {
        assert.ok(error instanceof MarginAuthError, '应为 MarginAuthError')
        assert.equal(error.message.includes('secret-token'), false, '错误信息不得含 token')
        return true
      })
    },
  )
})

test('403 同样映射为 MarginAuthError', async () => {
  await withServer(
    () => ({ status: 403, body: {} }),
    async ({ client }) => {
      await assert.rejects(() => client().listCandidates(), MarginAuthError)
    },
  )
})

test('上游错误信封的 message 与 category 透传', async () => {
  await withServer(
    () => ({ status: 422, body: { error: { code: 'invalid', category: 'validation_error', message: '参数不合法' } } }),
    async ({ client }) => {
      await assert.rejects(() => client().listCandidates(), error => {
        assert.ok(error instanceof MarginRequestError)
        assert.equal(error.status, 422)
        assert.equal(error.category, 'validation_error')
        assert.equal(error.message, '参数不合法')
        return true
      })
    },
  )
})

test('缺少 items 数组视为结构错误，不静默返回空列表', async () => {
  await withServer(
    () => ({ body: { pagination: { total: 3 } } }),
    async ({ client }) => {
      await assert.rejects(() => client().listCandidates(), MarginShapeError)
    },
  )
})

test('非 JSON 响应映射为结构错误', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html>not json</html>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const client = new MarginClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: 't', timeoutMs: 3000 })
    await assert.rejects(() => client.listCandidates(), MarginShapeError)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('非 JSON 的 404 错误保留状态，仍能区分“文章不存在”', async () => {
  const server = createServer((req, res) => {
    res.writeHead(404, { 'content-type': 'text/html' })
    res.end('<html>proxy: not found</html>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const client = new MarginClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: 't', timeoutMs: 3000 })
    await assert.rejects(() => client.listCandidates(), error => {
      assert.ok(error instanceof MarginRequestError)
      assert.equal(error.status, 404)
      assert.equal(error.message.includes('t'), false)
      return true
    })
    // getCandidate translates the typed 404 to "no such row".
    assert.equal(await client.getCandidate(42), undefined)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('连接失败映射为 status 0 的请求错误', async () => {
  // Port 1 is reserved and refuses connections.
  const client = new MarginClient({ baseUrl: 'http://127.0.0.1:1', token: 't', timeoutMs: 500 })
  await assert.rejects(() => client.listCandidates(), error => {
    assert.ok(error instanceof MarginRequestError)
    assert.equal(error.status, 0)
    assert.equal(error.message.includes('secret-token'), false, '错误信息不得含 token')
    assert.match(error.message, /无法连接|超时/)
    return true
  })
})

test('超时映射为超时错误', async () => {
  await withServer(
    () => ({ body: { items: [] } }),
    async ({ port }) => {
      const server = createServer(() => { /* never responds */ })
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      try {
        const client = new MarginClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: 't', timeoutMs: 150 })
        await assert.rejects(() => client.listCandidates(), error => {
          assert.ok(error instanceof MarginRequestError)
          assert.match(error.message, /超时/)
          return true
        })
      } finally {
        await new Promise(resolve => server.close(resolve))
      }
    },
  )
})

test('query 在客户端过滤标题/域名/标签，并受 limit 约束', async () => {
  await withServer(
    () => ({
      body: {
        items: [
          row({ id: 1, title: 'CUDA 兼容性', source_domain: 'martinfowler.com', tags: ['CUDA'] }),
          row({ id: 2, title: '企业 AI 账单', source_domain: 'yage-ai.kit.com', tags: ['OpenAI'] }),
          row({ id: 3, title: 'RSS 阅读器', source_domain: 'example.org', tags: [] }),
        ],
        pagination: { total: 3 },
      },
    }),
    async ({ client }) => {
      const byTitle = await client().listCandidates({ query: 'CUDA' })
      assert.deepEqual(byTitle.items.map(item => item.id), [1])
      const byDomain = await client().listCandidates({ query: 'kit.com' })
      assert.deepEqual(byDomain.items.map(item => item.id), [2])
      const byTag = await client().listCandidates({ query: 'openai' })
      assert.deepEqual(byTag.items.map(item => item.id), [2])
      const limited = await client().listCandidates({ limit: 2 })
      assert.equal(limited.items.length, 2)
      // total stays the server-reported figure — the UI shows backlog size.
      assert.equal(limited.total, 3)
    },
  )
})

test('getCandidate 在 404 时返回 undefined 而不是抛错', async () => {
  await withServer(
    url => url.pathname === '/api/candidates/9'
      ? { status: 404, body: { error: { message: '不存在' } } }
      : { body: row({ id: Number(url.pathname.split('/').pop()) }) },
    async ({ client }) => {
      assert.equal(await client().getCandidate(9), undefined)
      const found = await client().getCandidate(865)
      assert.equal(found.id, 865)
    },
  )
})

test('setCandidateStatus 发送显式 status，不是 toggle', async () => {
  let received = null
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      received = { method: req.method, path: req.url, body: JSON.parse(body || '{}') }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 865, status: 'read', is_saved_to_trilium: true, updated_at: '2026-10-25T10:00:00Z' }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const client = new MarginClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: 't', timeoutMs: 3000 })
    const updated = await client.setCandidateStatus(865, 'read')
    assert.equal(received.method, 'PATCH')
    assert.equal(received.path, '/api/candidates/865/status')
    assert.deepEqual(received.body, { status: 'read' })
    assert.deepEqual(updated, {
      id: 865, status: 'read', isSavedToTrilium: true, updatedAt: '2026-10-25T10:00:00Z',
    })
    assert.equal('title' in updated, false)
    assert.equal('summaryText' in updated, false)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('状态写入在网络请求前拒绝非法 ID 和非读写目标', async () => {
  await withServer(() => ({ body: {} }), async ({ client, seen }) => {
    for (const id of [0, -1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '865', null, undefined]) {
      await assert.rejects(() => client().setCandidateStatus(id, 'read'), MarginShapeError)
    }
    for (const status of ['processing', 'error', '', 'READ', null, undefined, {}, true]) {
      await assert.rejects(() => client().setCandidateStatus(865, status), MarginShapeError)
    }
    assert.equal(seen.length, 0)
  })
})

test('状态确认必须匹配请求 ID 和目标状态，不能虚报成功', async () => {
  for (const ack of [{ id: 866, status: 'read' }, { id: 865, status: 'unprocessed' }, {}, null, { id: '865', status: 'read' }]) {
    await withServer(() => ({ body: ack }), async ({ client }) => {
      await assert.rejects(() => client().setCandidateStatus(865, 'read'), MarginShapeError)
    })
  }
})

test('未读状态设置返回真实部分确认，重复设置不会 toggle', async () => {
  await withServer(() => ({ body: { id: 865, status: 'unprocessed', is_saved_to_trilium: false, updated_at: 'now' } }), async ({ client, seen }) => {
    const margin = client()
    assert.equal((await margin.setCandidateStatus(865, 'unprocessed')).status, 'unprocessed')
    assert.equal((await margin.setCandidateStatus(865, 'unprocessed')).status, 'unprocessed')
    assert.equal(seen.length, 2)
  })
})

test('原始单页列表来源本地精确过滤，页长上限100且不透传不支持参数', async () => {
  await withServer(() => ({ body: { items: [row({ id: 1, source_type: 'rss' }), row({ id: 2, source_type: 'wechat' })], pagination: { total: 2 } } }), async ({ client, seen }) => {
    const result = await client().listCandidates({ sourceType: 'wechat', pageSize: 200, query: '样本' })
    assert.deepEqual(result.items.map(item => item.id), [2])
    assert.equal(result.total, 2)
    assert.equal(seen[0].search.get('page_size'), '100')
    assert.equal(seen[0].search.has('source_type'), false)
    assert.equal(seen[0].search.has('query'), false)
  })
})

test('tallyBySource 跨页累加并按来源分组', async () => {
  await withServer(
    url => {
      const page = Number(url.searchParams.get('page') ?? '1')
      const items = page === 1
        ? [row({ id: 1, source_type: 'rss' }), row({ id: 2, source_type: 'rss' })]
        : [row({ id: 3, source_type: 'wechat' })]
      return { body: { items, pagination: { page, page_size: 100, total: 3, total_pages: 2 } } }
    },
    async ({ client }) => {
      const tally = await client().tallyBySource('unprocessed')
      assert.equal(tally.total, 3)
      assert.equal(tally.counts.get('rss'), 2)
      assert.equal(tally.counts.get('wechat'), 1)
      assert.equal(tally.truncated, false)
    },
  )
})

test('缺失的可选字段降级为安全默认值，不让整页失败', async () => {
  await withServer(
    () => ({ body: { items: [{ id: 7, title: '只有标题' }], pagination: { total: 1 } } }),
    async ({ client }) => {
      const page = await client().listCandidates()
      const item = page.items[0]
      assert.equal(item.id, 7)
      assert.equal(item.sourceUrl, '')
      assert.equal(item.status, 'unprocessed')
      assert.deepEqual(item.tags, [])
      assert.equal(item.category, null)
    },
  )
})

test('baseUrl 末尾斜杠不会产生双斜杠路径', async () => {
  await withServer(
    () => ({ body: { items: [], pagination: { total: 0 } } }),
    async ({ port, seen }) => {
      const client = new MarginClient({ baseUrl: `http://127.0.0.1:${port}///`, token: 't', timeoutMs: 3000 })
      await client.listCandidates()
      assert.equal(seen[0].path, '/api/candidates', '路径不得出现双斜杠')
    },
  )
})

test('baseUrl 末尾斜杠的两种写法打到同一路径', async () => {
  const paths = []
  await withServer(
    url => {
      paths.push(url.pathname)
      return { body: { items: [], pagination: { total: 0 } } }
    },
    async ({ port }) => {
      for (const suffix of ['', '/', '///']) {
        await new MarginClient({ baseUrl: `http://127.0.0.1:${port}${suffix}`, token: 't', timeoutMs: 3000 }).listCandidates()
      }
      assert.deepEqual(paths, ['/api/candidates', '/api/candidates', '/api/candidates'])
    },
  )
})

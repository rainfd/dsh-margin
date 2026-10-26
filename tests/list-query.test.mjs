import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

const { MarginClient, MarginShapeError } = await import('../lib/margin.js')

function row(id, source_type = 'rss', extra = {}) {
  return { id, title: `Article ${id}`, source_domain: 'example.com', source_type, tags: [], ...extra }
}

async function withPages(handler, run) {
  const seen = []
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    seen.push(url)
    const page = Number(url.searchParams.get('page'))
    const body = handler(page, url)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const client = new MarginClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'secret', timeoutMs: 3000 })
    await run(client, seen)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

function page(items, number = 1, total = items.length, totalPages = 1) {
  return { items, pagination: { page: number, page_size: 100, total, total_pages: totalPages } }
}

test('bounded query scans later pages and applies query, breakdown, source, then local pagination', async () => {
  const pages = [
    [row(1, 'rss', { title: 'AI first' }), row(2, 'wechat')],
    [row(3, 'wechat', { source_domain: 'ai.example' }), row(4, 'rss', { tags: ['AI'] })],
    [row(5, 'wechat', { title: 'ai last' }), row(6, 'wechat')],
  ]
  await withPages(n => page(pages[n - 1], n, 6, 3), async (client, seen) => {
    const view = await client.queryReadingList({ query: ' AI ', sourceType: ' wechat ', limit: 1, page: 2 })
    assert.deepEqual(view.items.map(item => item.id), [5])
    assert.deepEqual(view.breakdown, [{ sourceType: 'rss', count: 2 }, { sourceType: 'wechat', count: 2 }])
    assert.equal(view.total, 2)
    assert.equal(view.page, 2)
    assert.equal(view.pageSize, 1)
    assert.equal(view.totalPages, 2)
    assert.equal(view.scannedTotal, 6)
    assert.equal(view.upstreamTotal, 6)
    assert.equal(view.totalExact, true)
    assert.equal(view.truncated, false)
    assert.equal(view.writesAllowed, false)
    assert.deepEqual(view.applied, { status: 'unprocessed', query: 'AI', sourceType: 'wechat', limit: 1 })
    assert.equal(seen.length, 3)
    for (const url of seen) {
      assert.deepEqual([...url.searchParams.keys()].sort(), ['page', 'page_size', 'status'])
      assert.equal(url.searchParams.get('page_size'), '100')
    }
    assert.equal(JSON.stringify(view).includes('secret'), false)
  })
})

test('no filter defaults to local page size 60 and honors status upstream', async () => {
  await withPages(() => page(Array.from({ length: 65 }, (_, i) => row(i + 1))), async (client, seen) => {
    const view = await client.queryReadingList({ status: 'read', page: 99 })
    assert.equal(view.page, 2)
    assert.equal(view.items.length, 5)
    assert.equal(view.totalPages, 2)
    assert.equal(view.pageSize, 60)
    assert.deepEqual(view.applied, { status: 'read', sourceType: null, query: null, limit: 60 })
    assert.equal(seen[0].searchParams.get('status'), 'read')
  })
})

test('empty and out-of-range filtered pages clamp safely and preserve pre-source breakdown', async () => {
  await withPages(() => page([row(1), row(2, 'wechat')]), async client => {
    const none = await client.queryReadingList({ sourceType: 'RSS', page: 42, limit: 1 })
    assert.equal(none.total, 0)
    assert.equal(none.page, 1)
    assert.equal(none.totalPages, 1)
    assert.deepEqual(none.items, [])
    assert.equal(none.breakdown.length, 2)
    const search = await client.queryReadingList({ query: 'absent', page: 42 })
    assert.deepEqual(search.breakdown, [])
    assert.equal(search.page, 1)
    assert.equal(search.totalExact, true)
  })
  await withPages(() => page([], 1, 0, 0), async (client, seen) => {
    const view = await client.queryReadingList({ page: 99 })
    assert.equal(view.totalPages, 1)
    assert.equal(view.page, 1)
    assert.equal(view.totalExact, true)
    assert.equal(view.truncated, false)
    assert.equal(seen.length, 1)
  })
})

test('deduplicates IDs across pages without inflating totals or source breakdown', async () => {
  await withPages(n => page(n === 1 ? [row(1), row(2)] : [row(2), row(3, 'wechat')], n, 3, 2), async client => {
    const view = await client.queryReadingList()
    assert.deepEqual(view.items.map(item => item.id), [1, 2, 3])
    assert.equal(view.scannedTotal, 3)
    assert.equal(view.total, 3)
    assert.equal(view.totalExact, false)
    assert.equal(view.truncated, false)
    assert.deepEqual(view.breakdown, [{ sourceType: 'rss', count: 2 }, { sourceType: 'wechat', count: 1 }])
  })
})

test('server total changes mark observed totals inexact and retain last server total', async () => {
  await withPages(n => page(n === 1 ? [row(1)] : [row(2), row(3)], n, n === 1 ? 4 : 3, 2), async client => {
    const view = await client.queryReadingList()
    assert.equal(view.total, 3)
    assert.equal(view.upstreamTotal, 3)
    assert.equal(view.totalExact, false)
    assert.equal(view.truncated, false)
  })
})

test('early empty or premature last page is incomplete, stops immediately, and is never exact', async () => {
  for (const empty of [true, false]) {
    await withPages(n => page(n === 1 ? [row(1)] : empty ? [] : [row(2)], n, 8, empty ? 8 : 2), async (client, seen) => {
      const view = await client.queryReadingList()
      assert.equal(seen.length, 2)
      assert.equal(view.truncated, true)
      assert.equal(view.totalExact, false)
      assert.equal(view.upstreamTotal, 8)
      assert.equal(view.total, empty ? 1 : 2)
    })
  }
})

test('request cap bounds cross-page filtering and reports only observed matches', async () => {
  await withPages(n => page([row(n, n === 2 ? 'wechat' : 'rss')], n, 30, 30), async (client, seen) => {
    const view = await client.queryReadingList({ sourceType: 'wechat' }, 2)
    assert.equal(seen.length, 2)
    assert.deepEqual(view.items.map(item => item.id), [2])
    assert.equal(view.total, 1)
    assert.equal(view.scannedTotal, 2)
    assert.equal(view.upstreamTotal, 30)
    assert.equal(view.totalExact, false)
    assert.equal(view.truncated, true)
  })
})

test('maxPages is always safely bounded 1..20 even for malformed runtime values', async () => {
  for (const [maxPages, expected] of [[0, 1], [-2, 1], [1, 1], [999, 20], [NaN, 20], [Infinity, 20], [1.5, 20], ['1', 20]]) {
    await withPages(n => page([row(n)], n, 100, 100), async (client, seen) => {
      await client.queryReadingList({}, maxPages)
      assert.equal(seen.length, expected, `maxPages=${String(maxPages)}`)
    })
  }
})

test('local page size uses limit then pageSize, clamps 1..100, and rejects noninteger knobs safely', async () => {
  await withPages(() => page([row(1)]), async client => {
    for (const [options, size] of [[{ pageSize: 7 }, 7], [{ limit: 3, pageSize: 7 }, 3], [{ limit: 0 }, 1], [{ limit: 999 }, 100], [{ limit: NaN }, 60], [{ pageSize: Infinity }, 60]]) {
      const view = await client.queryReadingList({ ...options, page: NaN })
      assert.equal(view.pageSize, size)
      assert.equal(view.applied.limit, size)
      assert.equal(view.page, 1)
    }
  })
})

test('malformed pagination and invalid rows fail safely after one request', async () => {
  const valid = page([row(1)])
  const malformed = [
    null, {}, { items: [] }, { ...valid, pagination: null },
    ...['page', 'page_size', 'total', 'total_pages'].flatMap(key => [NaN, '1', -1, 1.5].map(value => ({ ...valid, pagination: { ...valid.pagination, [key]: value } }))),
    { ...valid, pagination: { ...valid.pagination, page: 2 } },
    { ...valid, pagination: { ...valid.pagination, page_size: 101 } },
    { ...valid, pagination: { ...valid.pagination, total_pages: 0 } },
    ...[null, {}, row(0), row(-1), row('1')].map(item => ({ ...valid, items: [item] })),
  ]
  for (const response of malformed) {
    await withPages(() => response, async (client, seen) => {
      await assert.rejects(() => client.queryReadingList(), error => {
        assert.ok(error instanceof MarginShapeError)
        assert.equal(error.message.includes('secret'), false)
        return true
      })
      assert.equal(seen.length, 1)
    })
  }
})

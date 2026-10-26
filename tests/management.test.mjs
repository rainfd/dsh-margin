import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canonicalDomain, cookieProblem, safeOrigin, safeUpstreamMessage, toCredentialMeta, toSchedulerMeta, toSourceMeta } from '../lib/management.js'

test('source projection drops the whole config dict, error text and URL paths', () => {
  const meta = toSourceMeta({
    id: 5, source_type: 'rss', label: '  Example\nfeed ', status: 'error',
    poll_interval_minutes: 90, consecutive_failures: 3,
    config: {
      feed_url: 'https://user:pass@example.com/private/feed.xml?token=SECRET_PATH',
      last_fetched_at: '2026-10-01T10:00:00Z', last_etag: 'W/"abc"',
      aggregation: { enabled: true }, unknown_secret: 'CANARY',
    },
    last_error_message: 'failed https://example.com/feed?token=CANARY', last_error_at: '2026-10-02T00:00:00Z',
    latest_entry_title: 'A post', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
  })
  assert.deepEqual(meta, {
    id: 5, sourceType: 'rss', label: 'Example feed', status: 'error',
    feedOrigin: '未验证', pollIntervalMinutes: 90, consecutiveFailures: 3,
    hasError: true, lastErrorAt: '2026-10-02T00:00:00Z', recordedFetchAt: '2026-10-01T10:00:00Z',
  })
  const serialized = JSON.stringify(meta)
  for (const canary of ['CANARY', 'SECRET_PATH', 'etag', 'aggregation', 'user:pass', 'A post']) assert.equal(serialized.includes(canary), false, canary)
})

test('source projection rejects unsafe ids and unknown statuses, and sanitises labels', () => {
  for (const bad of [null, [], {}, { id: 0 }, { id: -3 }, { id: 1.5 }, { id: '7' }]) assert.equal(toSourceMeta(bad), undefined)
  const meta = toSourceMeta({ id: 1, status: 'future', label: '\u0000\u0007', source_type: 'x'.repeat(80), config: { feed_url: 'ftp://x', last_fetched_at: 'not-a-date' } })
  assert.equal(meta.status, 'unknown')
  assert.equal(meta.label, '#1')
  assert.equal(meta.sourceType.length, 32)
  assert.equal(meta.feedOrigin, '未验证')
  assert.equal(meta.recordedFetchAt, null)
})

test('only bare HTTP(S) origins survive; credentials, query and odd schemes do not', () => {
  assert.equal(safeOrigin('https://example.com/feed?token=x'), 'https://example.com')
  assert.equal(safeOrigin('http://example.com:8080/a'), 'http://example.com:8080')
  for (const bad of ['https://u:p@example.com/feed', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/plain,x', '', 5, 'https://example.com/\n']) {
    assert.equal(safeOrigin(bad), null, String(bad))
  }
})

test('credential projection keeps metadata only and marks consumer coverage honestly', () => {
  assert.deepEqual(
    toCredentialMeta({ id: 3, domain: ' MP.Weixin.QQ.com ', cookie_configured: true, cookie_string: 'CANARY', created_at: '2026-01-01T00:00:00Z' }),
    { id: 3, domain: 'mp.weixin.qq.com', configured: true, supported: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: null },
  )
  assert.equal(toCredentialMeta({ id: 4, domain: 'bilibili.com', cookie_configured: true }).supported, false)
  assert.equal(toCredentialMeta({ id: 5, domain: 'other.example', cookie_configured: false, cookie_string: 'CANARY' }).configured, false)
  for (const bad of [{ id: 1, domain: '' }, { id: 1, domain: 'https://example.com' }, { id: 1, domain: 'a/b' }, { id: 0, domain: 'x.com' }, {}]) assert.equal(toCredentialMeta(bad), undefined)
})

test('domain canonicalisation is strict and never invents a host', () => {
  assert.equal(canonicalDomain(' Example.COM '), 'example.com')
  for (const bad of ['', 'http://example.com', 'example.com:443', 'user@example.com', 'a..b', '.example.com', 'example.com.', 'exa mple.com', 'x'.repeat(256), 7]) assert.equal(canonicalDomain(bad), undefined, String(bad))
})

test('cookie validation rejects empties, control characters and non name=value input', () => {
  assert.equal(cookieProblem('a=1; b=2'), undefined)
  for (const bad of ['', '   ', 'no-equals', 'a=1\u0000', 42, 'x'.repeat(8193)]) assert.equal(typeof cookieProblem(bad), 'string', String(bad).slice(0, 20))
})

test('scheduler projection reports only source-poll jobs and never a fake timestamp', () => {
  const meta = toSchedulerMeta({ scheduler_running: true, total_active_jobs: 2, jobs: [
    { content_source_id: 1, label: 'RSS Poll: private feed', next_run_time: '2026-10-25T12:00:00+08:00Z', poll_interval_minutes: 60 },
    { content_source_id: 0 }, { content_source_id: 2, next_run_time: 'garbage' }, { junk: true },
  ] })
  // The backend appends "Z" to an already-offset isoformat string, which is
  // unparsable; the projection must drop it instead of showing a fake time.
  assert.deepEqual(meta, { running: true, sourcePollJobs: 2, jobs: [
    { sourceId: 1, nextRunTime: null, intervalMinutes: 60 },
    { sourceId: 2, nextRunTime: null, intervalMinutes: null },
  ] })
  assert.equal(toSchedulerMeta({ jobs: [{ content_source_id: 9, next_run_time: '2026-10-25T12:00:00Z' }] }).jobs[0].nextRunTime, '2026-10-25T12:00:00Z')
  assert.equal(JSON.stringify(meta).includes('private feed'), false)
  assert.deepEqual(toSchedulerMeta(null), { running: false, sourcePollJobs: 0, jobs: [] })
  assert.equal(toSchedulerMeta({}).sourcePollJobs, 0)
  assert.equal(toSchedulerMeta({ jobs: [{ content_source_id: 1 }] }).sourcePollJobs, 1)
})

test('upstream failures map to fixed wording and never relay a message', () => {
  for (const status of [0, 401, 403, 404, 409, 422, 500, 502, 504, 418]) {
    const mapped = safeUpstreamMessage(status)
    assert.equal(typeof mapped.code, 'string')
    assert.equal(typeof mapped.message, 'string')
    assert.equal(/CANARY|sql|INSERT|password|cookie/i.test(mapped.message), false)
  }
  assert.equal(safeUpstreamMessage(504).code, 'margin_timeout')
  assert.match(safeUpstreamMessage(504).message, /不确定/)
})

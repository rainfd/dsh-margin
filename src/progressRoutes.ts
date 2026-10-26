/**
 * Reading-progress routes.
 *
 * Progress is local and disposable. It is never written to Margin, never marks
 * an article read, and keeps working with the plugin's write gate closed because
 * it does not touch the content store. Deleting a row only forgets a scroll
 * position; it cannot damage the article.
 *
 * `contentVersion` is supplied by the reader from the detail response it
 * rendered. It is opaque here: the plugin does not invent a "version" from the
 * title or length, because that would silently re-use a stale position.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { clearProgress, progressView, upsertProgress } from './progress.ts'
import { MARGIN_API } from './protocol.ts'

interface Responses {
  writeJson: (res: ServerResponse, status: number, body: unknown) => void
  writeError: (res: ServerResponse, status: number, code: string, message: string, category?: string, count?: number) => void
  readJsonBody: (req: IncomingMessage) => Promise<unknown>
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export function makeProgressRoutes(responses: Responses): WebRoute[] {
  const { writeJson, writeError, readJsonBody } = responses
  return [
    {
      kind: 'exact',
      path: `${MARGIN_API}/progress`,
      async handler(req, res) {
        const method = req.method ?? 'GET'
        if (method === 'GET') {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const rawLimit = Number(url.searchParams.get('limit') ?? 20)
          const limit = Number.isSafeInteger(rawLimit) && rawLimit > 0 ? rawLimit : 20
          writeJson(res, 200, progressView(limit))
          return
        }
        if (method !== 'POST') return writeError(res, 405, 'method_not_allowed', '仅支持 GET / POST')
        let body: unknown
        try { body = await readJsonBody(req) } catch { return writeError(res, 400, 'bad_body', '无效 JSON 请求体') }
        if (!record(body)) return writeError(res, 400, 'bad_body', '请求体必须是对象')
        const allowed = ['instanceUrl', 'candidateId', 'contentVersion', 'title', 'ratio', 'scrollTop', 'anchor']
        if (Object.keys(body).some(key => !allowed.includes(key))) return writeError(res, 400, 'bad_body', '请求包含未知字段')
        const { instanceUrl, candidateId, contentVersion, ratio } = body
        if (typeof instanceUrl !== 'string' || instanceUrl === '' || instanceUrl.length > 2048) {
          return writeError(res, 400, 'invalid_instance', 'instanceUrl 不合法')
        }
        if (typeof candidateId !== 'number' || !Number.isSafeInteger(candidateId) || candidateId <= 0) {
          return writeError(res, 400, 'invalid_id', 'candidateId 必须是正整数')
        }
        if (typeof contentVersion !== 'string' || contentVersion === '' || contentVersion.length > 64) {
          return writeError(res, 400, 'invalid_version', '缺少正文版本，无法安全恢复位置')
        }
        if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
          return writeError(res, 400, 'invalid_ratio', 'ratio 必须在 0–1 之间')
        }
        if (body.title !== undefined && (typeof body.title !== 'string' || body.title.length > 1000)) {
          return writeError(res, 400, 'invalid_title', 'title 不合法')
        }
        if (body.scrollTop !== undefined && (typeof body.scrollTop !== 'number' || !Number.isFinite(body.scrollTop) || body.scrollTop < 0)) {
          return writeError(res, 400, 'invalid_scroll', 'scrollTop 必须是非负数')
        }
        if (body.anchor !== undefined && (typeof body.anchor !== 'string' || body.anchor.length > 300)) {
          return writeError(res, 400, 'invalid_anchor', 'anchor 不合法')
        }
        const entry = upsertProgress({
          instanceUrl,
          candidateId,
          contentVersion,
          ratio,
          ...(typeof body.title === 'string' ? { title: body.title } : {}),
          ...(typeof body.scrollTop === 'number' ? { scrollTop: body.scrollTop } : {}),
          ...(typeof body.anchor === 'string' ? { anchor: body.anchor } : {}),
        })
        writeJson(res, 200, { entry })
      },
    },
    {
      kind: 'exact',
      path: `${MARGIN_API}/progress-clear`,
      async handler(req, res) {
        if (req.method !== 'POST') return writeError(res, 405, 'method_not_allowed', '仅支持 POST')
        let body: unknown
        try { body = await readJsonBody(req) } catch { return writeError(res, 400, 'bad_body', '无效 JSON 请求体') }
        if (!record(body)) return writeError(res, 400, 'bad_body', '请求体必须是对象')
        if (Object.keys(body).some(key => key !== 'key')) return writeError(res, 400, 'bad_body', '请求包含未知字段')
        if (body.key !== undefined && (typeof body.key !== 'string' || body.key.length > 4096)) {
          return writeError(res, 400, 'invalid_key', 'key 不合法')
        }
        const removed = clearProgress(typeof body.key === 'string' ? body.key : undefined)
        // Only local rows are removed; say so, since users may expect otherwise.
        writeJson(res, 200, { removed, scope: body.key === undefined ? 'all' : 'one', marginUntouched: true })
      },
    },
  ]
}

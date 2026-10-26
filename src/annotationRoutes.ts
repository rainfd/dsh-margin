/**
 * Highlights and notes routes.
 *
 * Write gates are separate from reading state and from article saving, because
 * annotations are user-authored content that outlives the article. Every write
 * is instance-bound and re-checks authorization after the body is read.
 *
 * Offsets are never derived from the rendered Markdown: Margin validates them
 * against `content_text`, so the selection is re-located there. When that fails
 * the plugin reports why instead of storing a highlight that would drift.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { MarginAuthError, MarginClient } from './margin.ts'
import { codePointOffset, fingerprint, locateSelection, noteProblem, toHighlight, toNote } from './highlights.ts'
import { MARGIN_API, type MarginAnnotationView } from './protocol.ts'
import { readConfig, type MarginConfig } from './store.ts'

export interface AnnotationPermissions {
  allowHighlightWrites?: () => boolean
  allowNoteWrites?: () => boolean
}

interface Responses {
  writeJson: (res: ServerResponse, status: number, body: unknown) => void
  writeError: (res: ServerResponse, status: number, code: string, message: string, category?: string, count?: number) => void
  readJsonBody: (req: IncomingMessage) => Promise<unknown>
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export function makeAnnotationRoutes(permissions: AnnotationPermissions, responses: Responses): WebRoute[] {
  const { writeJson, writeError, readJsonBody } = responses
  const instanceOf = (config: MarginConfig): string => config.baseUrl.replace(/\/+$/, '')

  const configured = (res: ServerResponse): MarginConfig | undefined => {
    const config = readConfig()
    if (config.baseUrl === '' || config.token === '') {
      writeError(res, 409, 'not_configured', '尚未配置 Margin 地址或 token')
      return undefined
    }
    return config
  }
  const grant = (res: ServerResponse, kind: 'highlight' | 'note'): boolean => {
    if ((kind === 'highlight' ? permissions.allowHighlightWrites?.() : permissions.allowNoteWrites?.()) === true) return true
    writeError(res, 403, 'writes_disabled', kind === 'highlight' ? '高亮写入未启用' : '笔记写入未启用')
    return false
  }
  const sameInstance = (res: ServerResponse, config: MarginConfig, value: unknown): boolean => {
    if (value === instanceOf(config)) return true
    writeError(res, 409, 'instance_changed', 'Margin 实例已变化，请刷新文章')
    return false
  }
  const upstream = (res: ServerResponse, error: unknown): void => {
    if (error instanceof MarginAuthError) return writeError(res, 401, 'margin_unauthorized', 'Margin 拒绝凭据（401）')
    const status = (error as { status?: unknown }).status
    if (status === 404) return writeError(res, 404, 'not_found', '目标不存在或已删除')
    if (status === 422) return writeError(res, 422, 'margin_rejected', 'Margin 拒绝了该内容（偏移或字段不合法）')
    if (status === 409) return writeError(res, 409, 'margin_conflict', 'Margin 报告冲突')
    if (typeof status === 'number' && status >= 400 && status < 500) return writeError(res, 400, 'margin_rejected', 'Margin 拒绝了请求')
    // 5xx bodies may quote stored note text; never relay them.
    writeError(res, 502, 'margin_upstream_error', 'Margin 内部错误；详情未转发')
  }

  const boundedId = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined

  return [
    {
      kind: 'exact',
      path: `${MARGIN_API}/annotations`,
      async handler(req, res) {
        if ((req.method ?? 'GET') !== 'GET') return writeError(res, 405, 'method_not_allowed', '仅支持 GET')
        const url = new URL(req.url ?? '/', 'http://localhost')
        const id = Number(url.searchParams.get('id'))
        if (!Number.isSafeInteger(id) || id <= 0) return writeError(res, 400, 'invalid_id', 'id 必须是正整数')
        const config = configured(res); if (!config) return
        if (!sameInstance(res, config, url.searchParams.get('instanceUrl'))) return
        const client = new MarginClient(config)
        try {
          const [detail, rawNotes, rawHighlights] = await Promise.all([
            client.getCandidate(id), client.listNotes(id), client.listHighlights(id),
          ])
          if (detail === undefined) return writeError(res, 404, 'not_found', 'Margin 中不存在该文章')
          writeJson(res, 200, {
            instanceUrl: instanceOf(config),
            candidateId: id,
            marginUrl: detail.marginUrl,
            writesAllowed: permissions.allowHighlightWrites?.() === true || permissions.allowNoteWrites?.() === true,
            // Without content_text no offset can be validated by Margin.
            offsetsAvailable: detail.contentText.trim() !== '',
            notes: rawNotes.map(toNote).filter(value => value !== undefined),
            highlights: rawHighlights.map(toHighlight).filter(value => value !== undefined),
          } satisfies MarginAnnotationView)
        } catch (error) { upstream(res, error) }
      },
    },
    {
      kind: 'exact',
      path: `${MARGIN_API}/highlight-create`,
      async handler(req, res) {
        if (req.method !== 'POST') return writeError(res, 405, 'method_not_allowed', '仅支持 POST')
        if (!grant(res, 'highlight')) return
        let body: unknown
        try { body = await readJsonBody(req) } catch { return writeError(res, 400, 'bad_body', '无效 JSON 请求体') }
        if (!record(body)) return writeError(res, 400, 'bad_body', '请求体必须是对象')
        if (Object.keys(body).some(key => !['candidateId', 'instanceUrl', 'selectedText', 'occurrence'].includes(key))) {
          return writeError(res, 400, 'bad_body', '请求包含未知字段')
        }
        const candidateId = boundedId(body.candidateId)
        if (candidateId === undefined) return writeError(res, 400, 'invalid_id', 'candidateId 必须是正整数')
        const selected = typeof body.selectedText === 'string' ? body.selectedText.trim() : ''
        if (selected === '') return writeError(res, 400, 'empty_selection', '请先选择正文内容')
        if (selected.length > 12_000) return writeError(res, 422, 'selection_too_long', '选段过长（最多 12000 字符）')
        const occurrence = body.occurrence === undefined ? -1 : body.occurrence
        if (!Number.isSafeInteger(occurrence) || ((occurrence as number) < 0 && occurrence !== -1)) return writeError(res, 400, 'invalid_occurrence', 'occurrence 必须是非负整数')
        const config = configured(res); if (!config || !sameInstance(res, config, body.instanceUrl) || !grant(res, 'highlight')) return
        const client = new MarginClient(config)
        try {
          const detail = await client.getCandidate(candidateId)
          if (detail === undefined) return writeError(res, 404, 'not_found', 'Margin 中不存在该文章')
          if (detail.contentText.trim() === '') return writeError(res, 422, 'offsets_unavailable', '该文章没有纯文本正文，无法按偏移保存高亮')
          const located = locateSelection(detail.contentText, selected, occurrence as number)
          if (!located.ok) {
            const message = located.reason === 'not-found' ? '在正文中找不到所选文字，请重新选择'
              : located.reason === 'ambiguous' ? `所选文字在正文中出现 ${located.count} 次，请指定第几处` : '选区为空'
            return writeError(
              res,
              located.reason === 'ambiguous' ? 409 : 422,
              located.reason === 'ambiguous' ? 'ambiguous_selection' : 'selection_not_located',
              message,
              undefined,
              // Structured, so the client renders a picker without parsing text.
              located.reason === 'ambiguous' ? located.count : undefined,
            )
          }
          // JS works in UTF-16 code units; Margin validates against Python
          // `content_text` (code points). Convert before sending so an emoji
          // before the selection cannot shift the anchor.
          const created = await client.createHighlight(candidateId, {
            start: codePointOffset(detail.contentText, located.value.start),
            end: codePointOffset(detail.contentText, located.value.end),
            selectedText: detail.contentText.slice(located.value.start, located.value.end),
            fingerprint: await fingerprint(selected),
          })
          const highlight = toHighlight(created)
          if (highlight === undefined) return writeError(res, 502, 'margin_bad_shape', 'Margin 返回了无法解析的高亮')
          writeJson(res, 201, { instanceUrl: instanceOf(config), highlight })
        } catch (error) { upstream(res, error) }
      },
    },
    {
      kind: 'exact',
      path: `${MARGIN_API}/highlight-link`,
      async handler(req, res) {
        if (req.method !== 'POST') return writeError(res, 405, 'method_not_allowed', '仅支持 POST')
        if (!grant(res, 'highlight')) return
        let body: unknown
        try { body = await readJsonBody(req) } catch { return writeError(res, 400, 'bad_body', '无效 JSON 请求体') }
        if (!record(body)) return writeError(res, 400, 'bad_body', '请求体必须是对象')
        if (Object.keys(body).some(key => !['highlightId', 'noteId', 'instanceUrl'].includes(key))) {
          return writeError(res, 400, 'bad_body', '请求包含未知字段')
        }
        const highlightId = boundedId(body.highlightId)
        if (highlightId === undefined) return writeError(res, 400, 'invalid_id', 'highlightId 必须是正整数')
        const noteId = body.noteId === null ? null : boundedId(body.noteId)
        if (body.noteId !== null && noteId === undefined) return writeError(res, 400, 'invalid_note_id', 'noteId 必须是正整数或 null')
        const config = configured(res); if (!config || !sameInstance(res, config, body.instanceUrl) || !grant(res, 'highlight')) return
        try {
          const highlight = toHighlight(await new MarginClient(config).linkHighlight(highlightId, noteId ?? null))
          if (highlight === undefined) return writeError(res, 502, 'margin_bad_shape', 'Margin 返回了无法解析的高亮')
          writeJson(res, 200, { instanceUrl: instanceOf(config), highlight })
        } catch (error) { upstream(res, error) }
      },
    },
    {
      kind: 'exact',
      path: `${MARGIN_API}/highlight-delete`,
      async handler(req, res) {
        if (req.method !== 'POST') return writeError(res, 405, 'method_not_allowed', '仅支持 POST')
        if (!grant(res, 'highlight')) return
        let body: unknown
        try { body = await readJsonBody(req) } catch { return writeError(res, 400, 'bad_body', '无效 JSON 请求体') }
        if (!record(body)) return writeError(res, 400, 'bad_body', '请求体必须是对象')
        if (Object.keys(body).some(key => !['highlightId', 'candidateId', 'instanceUrl', 'selectedText'].includes(key))) {
          return writeError(res, 400, 'bad_body', '请求包含未知字段')
        }
        const highlightId = boundedId(body.highlightId)
        if (highlightId === undefined) return writeError(res, 400, 'invalid_id', 'highlightId 必须是正整数')
        const candidateId = boundedId(body.candidateId)
        if (candidateId === undefined) return writeError(res, 400, 'invalid_id', 'candidateId 必须是正整数')
        if (typeof body.selectedText !== 'string' || body.selectedText.trim() === '') {
          return writeError(res, 400, 'confirm_required', '删除需确认所选文字')
        }
        const config = configured(res); if (!config || !sameInstance(res, config, body.instanceUrl) || !grant(res, 'highlight')) return
        const client = new MarginClient(config)
        try {
          // Confirm against live state so a stale panel cannot delete a changed row.
          const live = (await client.listHighlights(candidateId)).map(toHighlight)
            .find(highlight => highlight?.id === highlightId)
          if (live === undefined) return writeError(res, 404, 'not_found', '高亮不存在或已变化')
          if (live.selectedText !== body.selectedText.trim()) {
            return writeError(res, 409, 'confirmation_mismatch', '所选文字与当前高亮不符，请刷新后重试')
          }
          await client.deleteHighlight(highlightId)
          // Margin preserves the linked note when a highlight is deleted.
          writeJson(res, 200, { instanceUrl: instanceOf(config), deletedId: highlightId, notesPreserved: true })
        } catch (error) { upstream(res, error) }
      },
    },
    {
      kind: 'exact',
      path: `${MARGIN_API}/note-create`,
      async handler(req, res) {
        if (req.method !== 'POST') return writeError(res, 405, 'method_not_allowed', '仅支持 POST')
        if (!grant(res, 'note')) return
        let body: unknown
        try { body = await readJsonBody(req) } catch { return writeError(res, 400, 'bad_body', '无效 JSON 请求体') }
        if (!record(body)) return writeError(res, 400, 'bad_body', '请求体必须是对象')
        if (Object.keys(body).some(key => !['candidateId', 'content', 'instanceUrl'].includes(key))) {
          return writeError(res, 400, 'bad_body', '请求包含未知字段')
        }
        const candidateId = boundedId(body.candidateId)
        if (candidateId === undefined) return writeError(res, 400, 'invalid_id', 'candidateId 必须是正整数')
        const problem = noteProblem(body.content)
        if (problem !== undefined) return writeError(res, 400, 'invalid_content', problem)
        const config = configured(res); if (!config || !sameInstance(res, config, body.instanceUrl) || !grant(res, 'note')) return
        try {
          const note = toNote(await new MarginClient(config).createNote(candidateId, body.content as string))
          if (note === undefined) return writeError(res, 502, 'margin_bad_shape', 'Margin 返回了无法解析的笔记')
          writeJson(res, 201, { instanceUrl: instanceOf(config), note })
        } catch (error) { upstream(res, error) }
      },
    },
    {
      kind: 'exact',
      path: `${MARGIN_API}/note-update`,
      async handler(req, res) {
        if (req.method !== 'POST') return writeError(res, 405, 'method_not_allowed', '仅支持 POST')
        if (!grant(res, 'note')) return
        let body: unknown
        try { body = await readJsonBody(req) } catch { return writeError(res, 400, 'bad_body', '无效 JSON 请求体') }
        if (!record(body)) return writeError(res, 400, 'bad_body', '请求体必须是对象')
        if (Object.keys(body).some(key => !['candidateId', 'noteId', 'content', 'expectedContent', 'instanceUrl'].includes(key))) {
          return writeError(res, 400, 'bad_body', '请求包含未知字段')
        }
        const candidateId = boundedId(body.candidateId)
        if (candidateId === undefined) return writeError(res, 400, 'invalid_id', 'candidateId 必须是正整数')
        const noteId = boundedId(body.noteId)
        if (noteId === undefined) return writeError(res, 400, 'invalid_id', 'noteId 必须是正整数')
        const problem = noteProblem(body.content)
        if (problem !== undefined) return writeError(res, 400, 'invalid_content', problem)
        // Whole-content PUT needs the content the editor started from, so a
        // second tab cannot be silently overwritten (spec 007 acceptance).
        if (typeof body.expectedContent !== 'string') {
          return writeError(res, 400, 'confirm_required', '更新需提交编辑前的笔记内容')
        }
        const config = configured(res); if (!config || !sameInstance(res, config, body.instanceUrl) || !grant(res, 'note')) return
        const client = new MarginClient(config)
        try {
          const live = (await client.listNotes(candidateId)).map(toNote).find(note => note?.id === noteId)
          if (live === undefined) return writeError(res, 404, 'not_found', '笔记不存在或已变化')
          if (live.contentTruncated) {
            return writeError(res, 409, 'note_too_long', '笔记超过插件可安全编辑的长度（20000 字符），未更新')
          }
          if (live.content !== body.expectedContent) {
            return writeError(res, 409, 'confirmation_mismatch', '笔记内容已变化，请刷新后重试')
          }
          const note = toNote(await client.updateNote(noteId, body.content as string))
          if (note === undefined) return writeError(res, 502, 'margin_bad_shape', 'Margin 返回了无法解析的笔记')
          writeJson(res, 200, { instanceUrl: instanceOf(config), note })
        } catch (error) { upstream(res, error) }
      },
    },
    {
      kind: 'exact',
      path: `${MARGIN_API}/note-delete`,
      async handler(req, res) {
        if (req.method !== 'POST') return writeError(res, 405, 'method_not_allowed', '仅支持 POST')
        if (!grant(res, 'note')) return
        let body: unknown
        try { body = await readJsonBody(req) } catch { return writeError(res, 400, 'bad_body', '无效 JSON 请求体') }
        if (!record(body)) return writeError(res, 400, 'bad_body', '请求体必须是对象')
        if (Object.keys(body).some(key => !['noteId', 'candidateId', 'instanceUrl', 'content'].includes(key))) {
          return writeError(res, 400, 'bad_body', '请求包含未知字段')
        }
        const noteId = boundedId(body.noteId)
        if (noteId === undefined) return writeError(res, 400, 'invalid_id', 'noteId 必须是正整数')
        const candidateId = boundedId(body.candidateId)
        if (candidateId === undefined) return writeError(res, 400, 'invalid_id', 'candidateId 必须是正整数')
        // Irreversible in Margin (hard delete), so require the content as proof.
        if (typeof body.content !== 'string' || body.content.trim() === '') {
          return writeError(res, 400, 'confirm_required', '删除需确认笔记内容')
        }
        const config = configured(res); if (!config || !sameInstance(res, config, body.instanceUrl) || !grant(res, 'note')) return
        const client = new MarginClient(config)
        try {
          // Verify against live state: a stale panel must not delete edited content.
          const live = (await client.listNotes(candidateId)).map(toNote).find(note => note?.id === noteId)
          if (live === undefined) return writeError(res, 404, 'not_found', '笔记不存在或已变化')
          if (live.contentTruncated) {
            return writeError(res, 409, 'note_too_long', '笔记超过插件可安全核对的长度（20000 字符），未删除')
          }
          if (live.content !== body.content) {
            return writeError(res, 409, 'confirmation_mismatch', '笔记内容已变化，请刷新后重试')
          }
          await client.deleteNote(noteId)
          // Margin hard-deletes the note and detaches highlights from it.
          writeJson(res, 200, { instanceUrl: instanceOf(config), deletedId: noteId, highlightsDetached: true })
        } catch (error) { upstream(res, error) }
      },
    },
  ]
}

/**
 * Trilium save: explicit, instance-scoped, deduplicated.
 *
 * Design boundaries (spec 006):
 *  - Only a user action saves. Reading, summarizing, and AI output never save.
 *  - Identity is Margin instance + candidate id; the same id on another
 *    instance is a different article.
 *  - Pre-check, then write; a lost or ambiguous reply is reported as unknown and
 *    verified by re-reading before any retry is offered.
 *  - The Margin save record id is the dedup key, not a bare boolean. A bare
 *    `is_saved_to_trilium` cannot distinguish "saved once" from "saved twice".
 *  - This plugin never writes into Trilium directly: Margin's own save endpoint
 *    owns the target note, parent directory and content assembly, so there is
 *    exactly one writer and no divergent duplicate copy.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { MarginAuthError, MarginClient } from './margin.ts'
import { MARGIN_API } from './protocol.ts'
import { readConfig, type MarginConfig } from './store.ts'

export interface SavePermissions {
  allowTriliumSave?: () => boolean
}

interface Responses {
  writeJson: (res: ServerResponse, status: number, body: unknown) => void
  writeError: (res: ServerResponse, status: number, code: string, message: string, category?: string, count?: number) => void
  readJsonBody: (req: IncomingMessage) => Promise<unknown>
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const text = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : ''

export interface SaveState {
  candidateId: number
  marginUrl: string
  saved: boolean
  saveRecordId: number | null
  externalRef: string | null
  savedAt: string | null
  /** Ambiguous: a save request was accepted but its outcome is unverified. */
  needsVerification: boolean
}

/** Project one save receipt without relaying upstream prose. */
export function toSaveState(raw: unknown, candidateId: number, marginUrl: string): SaveState {
  if (!record(raw)) throw new Error('save receipt missing')
  const saved = raw['status'] === 'success'
  const saveRecordId = raw['save_record_id']
  const externalRef = raw['external_ref']
  return {
    candidateId,
    marginUrl,
    saved,
    saveRecordId: typeof saveRecordId === 'number' && Number.isSafeInteger(saveRecordId) && saveRecordId > 0 ? saveRecordId : null,
    // A Trilium note id is shown so the user can find the produced note.
    externalRef: typeof externalRef === 'string' && externalRef !== '' ? text(externalRef, 200) : null,
    savedAt: typeof raw['saved_at'] === 'string' && !Number.isNaN(Date.parse(raw['saved_at'])) ? raw['saved_at'] : null,
    needsVerification: false,
  }
}

/** Status for a failed save, with wording that cannot leak a note body. */
function mapSaveFailure(status: number): { http: number; code: string; message: string } {
  if (status === 401 || status === 403) return { http: 401, code: 'margin_unauthorized', message: 'Margin 拒绝凭据（401）' }
  if (status === 404) return { http: 404, code: 'candidate_not_found', message: 'Margin 中不存在该文章' }
  if (status === 409) return { http: 409, code: 'save_conflict', message: '该文章正在保存或已保存；请重新只读核对，勿重复提交' }
  if (status === 422) return { http: 422, code: 'trilium_not_configured', message: 'Margin 尚未配置 Trilium 连接，或目标父笔记不是 Book' }
  if (status === 504) return { http: 504, code: 'trilium_timeout', message: '结果不确定：保存可能已成功，请重新核对后再决定是否重试' }
  if (status >= 500) return { http: 502, code: 'trilium_save_failed', message: '保存失败；详情未转发（可能含笔记内容）' }
  return { http: 502, code: 'trilium_save_failed', message: `保存请求失败（HTTP ${status}）` }
}

export function makeSaveRoutes(permissions: SavePermissions, responses: Responses): WebRoute[] {
  const { writeJson, writeError, readJsonBody } = responses
  const allowed = (): boolean => permissions.allowTriliumSave?.() === true

  const configured = (res: ServerResponse): { config: MarginConfig; instanceUrl: string } | undefined => {
    const config = readConfig()
    if (config.baseUrl === '' || config.token === '') {
      writeError(res, 409, 'not_configured', '尚未配置 Margin 地址或 token')
      return undefined
    }
    return { config, instanceUrl: config.baseUrl.replace(/\/+$/, '') }
  }

  return [
    {
      kind: 'exact',
      path: `${MARGIN_API}/save-state`,
      async handler(req, res) {
        if ((req.method ?? 'GET') !== 'GET') return writeError(res, 405, 'method_not_allowed', '仅支持 GET')
        const url = new URL(req.url ?? '/', 'http://localhost')
        const id = Number(url.searchParams.get('id'))
        if (!Number.isSafeInteger(id) || id <= 0) return writeError(res, 400, 'invalid_id', 'id 必须是正整数')
        const config = configured(res); if (!config) return
        const instance = url.searchParams.get('instanceUrl')
        if (instance !== config.instanceUrl) return writeError(res, 409, 'instance_changed', 'Margin 实例已变化，请刷新')
        try {
          const detail = await new MarginClient(config.config).getCandidate(id)
          if (detail === undefined) return writeError(res, 404, 'not_found', 'Margin 中不存在该文章')
          // Only the boolean is durable here; the plugin never claims a note id
          // it has not observed, and never treats the flag as success of a retry.
          writeJson(res, 200, {
            instanceUrl: config.instanceUrl,
            candidateId: id,
            marginUrl: detail.marginUrl,
            saved: detail.isSavedToTrilium,
            saveRecordId: null,
            externalRef: null,
            savedAt: null,
            needsVerification: false,
            saveAllowed: allowed(),
          } satisfies SaveState & { instanceUrl: string; saveAllowed: boolean })
        } catch (error) {
          if (error instanceof MarginAuthError) return writeError(res, 401, 'margin_unauthorized', 'Margin 拒绝凭据（401）')
          writeError(res, 502, 'margin_unavailable', '无法读取保存状态；未执行保存')
        }
      },
    },
    {
      kind: 'exact',
      path: `${MARGIN_API}/save-trilium`,
      async handler(req, res) {
        if (req.method !== 'POST') return writeError(res, 405, 'method_not_allowed', '仅支持 POST')
        if (!allowed()) return writeError(res, 403, 'saves_disabled', '保存到 Trilium 未启用')
        const config = configured(res); if (!config) return
        let body: unknown
        try { body = await readJsonBody(req) } catch { return writeError(res, 400, 'bad_body', '无效 JSON 请求体') }
        if (!record(body)) return writeError(res, 400, 'bad_body', '请求体必须是对象')
        if (Object.keys(body).some(key => !['candidateId', 'instanceUrl', 'marginUrl'].includes(key))) {
          return writeError(res, 400, 'bad_body', '请求包含未知字段')
        }
        const { candidateId, instanceUrl, marginUrl } = body
        if (typeof candidateId !== 'number' || !Number.isSafeInteger(candidateId) || candidateId <= 0) {
          return writeError(res, 400, 'invalid_id', 'candidateId 必须是正整数')
        }
        if (instanceUrl !== config.instanceUrl) return writeError(res, 409, 'instance_changed', 'Margin 实例已变化，请刷新')
        if (typeof marginUrl !== 'string' || marginUrl !== `${config.instanceUrl}/reader/${candidateId}`) {
          return writeError(res, 409, 'instance_changed', '文章标识与当前实例不符，请刷新')
        }
        // Revocation during body read must still fail closed.
        if (!allowed()) return writeError(res, 403, 'saves_disabled', '保存到 Trilium 未启用')

        const client = new MarginClient(config.config)
        // The only write attempt in this plugin. Once it has been issued, a
        // lost reply must be verified against Margin's authoritative flag
        // before any failure is reported: the backend accepts repeated
        // successful saves, so a blind retry could create a second note.
        let writeAttempted = false
        const verifySaved = async (): Promise<boolean> => {
          try {
            const after = await client.getCandidate(candidateId)
            return after?.isSavedToTrilium === true
          } catch {
            return false
          }
        }
        const verifiedReply = (): void => {
          writeJson(res, 200, {
            instanceUrl: config.instanceUrl,
            candidateId,
            marginUrl,
            saved: true,
            // No receipt was observed, so no id is invented.
            saveRecordId: null,
            externalRef: null,
            savedAt: null,
            needsVerification: true,
          } satisfies SaveState & { instanceUrl: string })
        }
        try {
          // Pre-check: never re-save something already stored.
          const before = await client.getCandidate(candidateId)
          if (before === undefined) return writeError(res, 404, 'candidate_not_found', 'Margin 中不存在该文章')
          if (before.isSavedToTrilium) {
            return writeError(res, 409, 'already_saved', '该文章已保存到 Trilium；未重复创建笔记')
          }
          writeAttempted = true
          const receipt = await client.saveToTrilium(candidateId)
          const state = toSaveState(receipt, candidateId, marginUrl)
          if (!state.saved || state.saveRecordId === null) {
            // The write happened but the receipt is unusable. Re-read the
            // authoritative flag rather than declaring failure.
            if (await verifySaved()) return verifiedReply()
            return writeError(res, 502, 'save_unconfirmed', '保存回执不完整；未确认成功，请重新核对')
          }
          writeJson(res, 200, { instanceUrl: config.instanceUrl, ...state })
        } catch (error) {
          if (error instanceof MarginAuthError) return writeError(res, 401, 'margin_unauthorized', 'Margin 拒绝凭据（401）')
          const status = (error as { status?: unknown }).status
          // Timeout/network (0), 5xx and unparseable replies leave the outcome
          // unknown. Verify first; only report failure after a clean re-read.
          if (writeAttempted && (typeof status !== 'number' || status === 0 || status >= 500)) {
            if (await verifySaved()) return verifiedReply()
            if (typeof status !== 'number' || status === 0) {
              return writeError(res, 504, 'save_unconfirmed', '结果不确定：保存请求可能已生效，请重新核对后再决定是否重试')
            }
          }
          const mapped = mapSaveFailure(typeof status === 'number' ? status : 0)
          writeError(res, mapped.http, mapped.code, mapped.message)
        }
      },
    },
  ]
}

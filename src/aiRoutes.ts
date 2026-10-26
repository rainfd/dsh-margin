/**
 * Optional AI route: explicit, on-demand reading assistance.
 *
 * Nothing here writes anywhere. Opening an article never calls a model, and no
 * tool exposes this path, so article text cannot drift into the agent transcript
 * by accident. The model is resolved lazily from `ctx.get('llm')`; when DSH has
 * no provider mounted the route answers "unavailable" and reading still works.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { MarginClient } from './margin.ts'
import { MARGIN_API } from './protocol.ts'
import { readConfig } from './store.ts'
import {
  AI_MAX_OUTPUT_TOKENS, aiFailureMessage, buildPrompt, parseRunRequest, resolveTarget, sanitizeOutput,
  type AiStreamChunk, type LlmLike,
} from './aiContext.ts'

/** Overall wall-clock ceiling; the model stream is aborted when it expires. */
const RUN_BUDGET_MS = 120_000

export interface AiPermissions {
  allowAi?: () => boolean
}

interface Responses {
  writeJson: (res: ServerResponse, status: number, body: unknown) => void
  writeError: (res: ServerResponse, status: number, code: string, message: string, category?: string, count?: number) => void
  readJsonBody: (req: IncomingMessage) => Promise<unknown>
}

/** Model preferences live in plugin config; unset means "first catalog entry". */
export interface AiConfig {
  provider?: string
  model?: string
}

/** Read the model service without making the plugin depend on it. */
type ServiceLookup = { get?: (name: string) => unknown }

export function lookupLlm(ctx: unknown): LlmLike | undefined {
  const candidate = (ctx as ServiceLookup | undefined)?.get?.('llm')
  if (candidate === null || typeof candidate !== 'object') return undefined
  const stream = (candidate as LlmLike).stream
  return typeof stream === 'function' ? candidate as LlmLike : undefined
}

/** Collect one streamed answer, honouring cancellation and the deadline. */
async function collect(
  llm: LlmLike,
  prompt: ReturnType<typeof buildPrompt>,
  target: { provider: string; model: string },
  signal: AbortSignal,
): Promise<{ text: string } | { failure: string }> {
  let text = ''
  let settled = false
  for await (const chunk of llm.stream({
    provider: target.provider,
    model: target.model,
    system: prompt.system,
    messages: prompt.messages,
    maxTokens: AI_MAX_OUTPUT_TOKENS,
    temperature: 0,
    signal,
  }) as AsyncIterable<AiStreamChunk>) {
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    if (chunk.type === 'finish') {
      settled = true
      const kind = chunk.reason?.kind
      if (kind === 'error' || kind === 'aborted') return { failure: aiFailureMessage(kind, chunk.reason?.failure?.code) }
      if (kind !== 'stop') return { failure: aiFailureMessage('error') }
    }
  }
  if (!settled) return { failure: '模型未返回结束标记；结果不完整，未保存' }
  if (text.trim() === '') return { failure: '模型返回了空内容' }
  return { text: sanitizeOutput(text) }
}

export function makeAiRoutes(permissions: AiPermissions, aiConfig: AiConfig, responses: Responses, llm: () => LlmLike | undefined): WebRoute[] {
  const { writeJson, writeError, readJsonBody } = responses
  const allowed = (): boolean => permissions.allowAi?.() === true

  return [
    {
      kind: 'exact',
      path: `${MARGIN_API}/ai-capability`,
      async handler(req, res) {
        if ((req.method ?? 'GET') !== 'GET') return writeError(res, 405, 'method_not_allowed', '仅支持 GET')
        const enabled = allowed()
        const service = llm()
        let target: { provider: string; model: string } | undefined
        if (service !== undefined) {
          try { target = await resolveTarget(service, aiConfig) } catch { target = undefined }
        }
        writeJson(res, 200, {
          enabled,
          modelAvailable: service !== undefined && target !== undefined,
          // Provider/model ids are configuration labels, never credentials.
          target: target ?? null,
          limits: { selectionChars: 12_000, maxOutputTokens: AI_MAX_OUTPUT_TOKENS },
        })
      },
    },
    {
      kind: 'exact',
      path: `${MARGIN_API}/ai-run`,
      async handler(req, res) {
        if (req.method !== 'POST') return writeError(res, 405, 'method_not_allowed', '仅支持 POST')
        if (!allowed()) return writeError(res, 403, 'ai_disabled', 'AI 功能未启用')
        const config = readConfig()
        if (config.baseUrl === '' || config.token === '') return writeError(res, 409, 'not_configured', '尚未配置 Margin 地址或 token')
        const instanceUrl = config.baseUrl.replace(/\/+$/, '')
        // Budget covers the whole run (article fetch + model stream), and the
        // listener is registered before any await: `req` emits 'close' as soon
        // as its body is consumed, so only the response's 'close' can tell us
        // that the caller actually went away.
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), RUN_BUDGET_MS)
        const onClose = (): void => { if (!res.writableEnded) controller.abort() }
        res.once('close', onClose)
        try {
          let body: unknown
          try { body = await readJsonBody(req) } catch { return writeError(res, 400, 'bad_body', '无效 JSON 请求体') }
          const parsed = parseRunRequest(body, instanceUrl)
          if (!parsed.ok) return writeError(res, 400, parsed.code, parsed.message)
          if (!allowed()) return writeError(res, 403, 'ai_disabled', 'AI 功能未启用')
          const service = llm()
          if (service === undefined) return writeError(res, 503, 'model_unavailable', '当前 DSH 没有可用的模型服务')
          let target: { provider: string; model: string } | undefined
          try { target = await resolveTarget(service, aiConfig) } catch { target = undefined }
          if (target === undefined) return writeError(res, 503, 'model_unavailable', '没有可用的模型，请在 DSH 中配置模型提供方')

          let detail
          try {
            detail = await new MarginClient(config).getCandidate(parsed.value.candidateId)
          } catch {
            return writeError(res, 504, 'margin_unavailable', '无法从 Margin 读取正文；本次未调用模型')
          }
          if (detail === undefined) return writeError(res, 404, 'not_found', 'Margin 中不存在该文章')
          // The overall budget may have expired while reading the article.
          if (controller.signal.aborted) return writeError(res, 504, 'ai_timeout', '已超时或已取消；本次未调用模型')
          if (detail.contentMd.trim() === '' && detail.contentText.trim() === '') {
            return writeError(res, 422, 'empty_content', '该文章没有可读正文；不会凭空生成')
          }

          const prompt = buildPrompt({ article: detail, mode: parsed.value.mode, ...(parsed.value.question === undefined ? {} : { question: parsed.value.question }), ...(parsed.value.selection === undefined ? {} : { selection: parsed.value.selection }) })
          try {
            const result = await collect(service, prompt, target, controller.signal)
            if ('failure' in result) {
              // A cancelled run is reported as cancelled, never as a partial answer.
              return writeError(res, controller.signal.aborted ? 504 : 502, controller.signal.aborted ? 'ai_timeout' : 'ai_failed', result.failure)
            }
            writeJson(res, 200, {
              instanceUrl,
              candidateId: detail.id,
              mode: parsed.value.mode,
              provider: target.provider,
              model: target.model,
              text: result.text,
              coverage: prompt.coverage,
              generated: true,
            })
          } catch {
            // A provider that throws AbortError on cancellation must still be
            // reported as an abort, not as an opaque failure.
            if (controller.signal.aborted) {
              return writeError(res, 504, 'ai_timeout', '已取消或超时；未保留部分结果，也未写入任何数据')
            }
            writeError(res, 502, 'ai_failed', '模型调用失败；未写入任何数据')
          }
        } finally {
          clearTimeout(timer)
          res.off('close', onClose)
        }
      },
    },
  ]
}

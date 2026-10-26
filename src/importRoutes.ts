import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { isIP } from 'node:net'
import { MarginClient } from './margin.ts'
import { MARGIN_API, MARGIN_MAX_PDF_BYTES, type MarginImportReceipt, type MarginImportView } from './protocol.ts'
import { readConfig, type MarginConfig } from './store.ts'

export interface ImportPermissions {
  allowUrlImports?: () => boolean
  allowPdfImports?: () => boolean
}

interface Responses {
  writeJson: (res: ServerResponse, status: number, body: unknown) => void
  writeError: (res: ServerResponse, status: number, code: string, message: string, category?: string, count?: number) => void
  mapClientError: (res: ServerResponse, error: unknown) => void
  readJsonBody: (req: IncomingMessage) => Promise<unknown>
}

const instance = (config: MarginConfig): string => config.baseUrl.replace(/\/+$/, '')
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Cheap literal-host rejection only. DNS/redirect SSRF defenses remain Margin's job. */
export function validImportUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 8192 || /[\s\u0000-\u001f\u007f]/.test(value)) return false
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false
    const family = isIP(host)
    if (family === 4) {
      const [a, b] = host.split('.').map(Number)
      if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
        || (a === 100 && b >= 64 && b <= 127)) return false
    }
    // Conservative IPv6 literal support: reject literals rather than attempt
    // to replace the backend's complete IPv6/private/resolution policy.
    if (family === 6) return false
    return true
  } catch { return false }
}

class UploadProblem extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

/** Bounded binary read; never creates a path or decodes the PDF as UTF-8. */
async function readMultipart(req: IncomingMessage): Promise<FormData> {
  const max = MARGIN_MAX_PDF_BYTES + 64 * 1024
  const contentType = req.headers['content-type'] ?? ''
  const match = /^multipart\/form-data;\s*boundary=(?:"([^"\r\n]+)"|([^;\s]+))$/i.exec(contentType)
  const boundary = match?.[1] ?? match?.[2]
  if (!boundary || boundary.length > 70 || !/^[\w'()+,\-./:=?]+$/.test(boundary)) throw new UploadProblem(400, 'bad_multipart', '需要有效的 multipart/form-data')
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > max) throw new UploadProblem(413, 'pdf_too_large', '上传体积超过限制')
  let size = 0
  const chunks: Buffer[] = []
  // Do not destroy the socket on early return: it must still carry the 413.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > max) throw new UploadProblem(413, 'pdf_too_large', '上传体积超过限制')
    chunks.push(bytes)
  }
  const bytes = Buffer.concat(chunks)
  // Bound parser part count before it allocates File/field objects. Expected:
  // file + instanceUrl + closing delimiter. No extra fields/files are accepted.
  const delimiter = Buffer.from(`--${boundary}`)
  let cursor = 0, count = 0
  while ((cursor = bytes.indexOf(delimiter, cursor)) !== -1) {
    if (++count > 3) throw new UploadProblem(400, 'bad_multipart', '只允许一个 PDF 文件与实例字段')
    cursor += delimiter.length
  }
  try {
    return await new Request('http://localhost/', { method: 'POST', headers: { 'content-type': contentType }, body: bytes }).formData()
  } catch { throw new UploadProblem(400, 'bad_multipart', '无法解析上传内容') }
}

/** Import handlers are wrapped by the same DSH connection gate as every route. */
export function makeImportRoutes(permissions: ImportPermissions, responses: Responses): WebRoute[] {
  const { writeJson, writeError, mapClientError, readJsonBody } = responses
  const allowed = (kind: 'url' | 'pdf') => (kind === 'url' ? permissions.allowUrlImports?.() : permissions.allowPdfImports?.()) === true
  const connection = (res: ServerResponse): MarginConfig | undefined => {
    const config = readConfig()
    if (!config.baseUrl || !config.token) {
      writeError(res, 409, 'not_configured', '尚未配置 Margin 地址或 token')
      return undefined
    }
    return config
  }
  const matches = (res: ServerResponse, config: MarginConfig, expected: unknown): boolean => {
    if (expected === instance(config)) return true
    writeError(res, 409, 'instance_changed', 'Margin 实例已变化，请刷新导入面板')
    return false
  }
  const grant = (res: ServerResponse, kind: 'url' | 'pdf'): boolean => {
    if (allowed(kind)) return true
    writeError(res, 403, 'imports_disabled', '该类型导入未启用')
    return false
  }
  return [
    { kind: 'exact', path: `${MARGIN_API}/imports`, async handler(req, res) {
      if (req.method !== 'GET') return writeError(res, 405, 'method_not_allowed', '仅支持 GET')
      const config = connection(res); if (!config) return
      try {
        const tasks = await new MarginClient(config).listImportQueue()
        writeJson(res, 200, { instanceUrl: instance(config), urlAllowed: allowed('url'), pdfAllowed: allowed('pdf'), maxPdfBytes: MARGIN_MAX_PDF_BYTES, recentLimit: 20, tasks } satisfies MarginImportView)
      } catch (error) { mapClientError(res, error) }
    } },
    { kind: 'exact', path: `${MARGIN_API}/import-task`, async handler(req, res) {
      if (req.method !== 'GET') return writeError(res, 405, 'method_not_allowed', '仅支持 GET')
      const config = connection(res); if (!config) return
      const url = new URL(req.url ?? '/', 'http://localhost')
      const id = Number(url.searchParams.get('id'))
      if (!Number.isSafeInteger(id) || id <= 0) return writeError(res, 400, 'invalid_id', 'id 必须是正整数')
      if (!matches(res, config, url.searchParams.get('instanceUrl'))) return
      try {
        const task = await new MarginClient(config).getImportTask(id)
        if (!task) return writeError(res, 404, 'task_unknown', '任务未找到；不表示成功或取消')
        writeJson(res, 200, { instanceUrl: instance(config), task } satisfies MarginImportReceipt)
      } catch (error) { mapClientError(res, error) }
    } },
    { kind: 'exact', path: `${MARGIN_API}/import-url`, async handler(req, res) {
      if (req.method !== 'POST') return writeError(res, 405, 'method_not_allowed', '仅支持 POST')
      if (!grant(res, 'url')) return
      let body: unknown
      try { body = await readJsonBody(req) } catch { return writeError(res, 400, 'bad_body', '无效 JSON 请求体') }
      if (!record(body) || Object.keys(body).some(key => !['url', 'instanceUrl'].includes(key)) || !validImportUrl(body.url)) return writeError(res, 400, 'invalid_url', '请输入不含凭据的公共 HTTP(S) 链接')
      const config = connection(res); if (!config || !matches(res, config, body.instanceUrl) || !grant(res, 'url')) return
      try {
        const task = await new MarginClient(config).importUrl(body.url)
        writeJson(res, 202, { instanceUrl: instance(config), task } satisfies MarginImportReceipt)
      } catch (error) { mapClientError(res, error) }
    } },
    { kind: 'exact', path: `${MARGIN_API}/import-pdf`, async handler(req, res) {
      if (req.method !== 'POST') return writeError(res, 405, 'method_not_allowed', '仅支持 POST')
      if (!grant(res, 'pdf')) return
      try {
        const form = await readMultipart(req)
        const keys = [...form.keys()]
        if (keys.length !== 2 || form.getAll('file').length !== 1 || form.getAll('instanceUrl').length !== 1 || keys.some(key => !['file', 'instanceUrl'].includes(key))) throw new UploadProblem(400, 'bad_multipart', '只允许一个 PDF 文件与实例字段')
        const file = form.get('file')
        if (!(file instanceof File) || !file.name || !/\.pdf$/i.test(file.name) || !['application/pdf', 'application/octet-stream', ''].includes(file.type)) throw new UploadProblem(422, 'invalid_pdf', '需要 PDF 文件')
        if (file.size > MARGIN_MAX_PDF_BYTES) throw new UploadProblem(413, 'pdf_too_large', 'PDF 最大支持 10 MiB')
        if (!file.size) throw new UploadProblem(422, 'invalid_pdf', 'PDF 不能为空')
        const bytes = new Uint8Array(await file.arrayBuffer())
        if (Buffer.from(bytes.subarray(0, 5)).toString('ascii') !== '%PDF-') throw new UploadProblem(422, 'invalid_pdf', '文件不是 PDF')
        const config = connection(res); if (!config || !matches(res, config, form.get('instanceUrl')) || !grant(res, 'pdf')) return
        const task = await new MarginClient(config).importPdf(bytes, file.name)
        writeJson(res, 202, { instanceUrl: instance(config), task } satisfies MarginImportReceipt)
      } catch (error) {
        if (error instanceof UploadProblem) {
          writeError(res, error.status, error.code, error.message)
          if (error.status === 413) req.resume()
        } else mapClientError(res, error)
      }
    } },
  ]
}

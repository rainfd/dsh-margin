import { MARGIN_MAX_PDF_BYTES, type MarginImportReceipt, type MarginImportTask, type MarginImportView } from '../protocol.ts'
import { MarginApiError } from './api.ts'
import { safeMarginUrl } from './readerModel.ts'

export interface ImportApi {
  loadImports(): Promise<MarginImportView>
  importUrl(url: string, instanceUrl: string): Promise<MarginImportReceipt>
  importPdf(file: File, instanceUrl: string): Promise<MarginImportReceipt>
  loadImportTask(id: number, instanceUrl: string): Promise<MarginImportReceipt>
}

export function submissionKey(kind: 'url' | 'pdf', input: string | File): string {
  return kind === 'url' ? 'url:' + String(input).trim() : `pdf:${(input as File).name}:${(input as File).size}:${(input as File).lastModified}`
}

export function completed(task: MarginImportTask): boolean { return task.status === 'unprocessed' || task.status === 'read' }
/** Match the configured instance and candidate route, not just an arbitrary HTTP link. */
export function taskBelongsToInstance(task: MarginImportTask, instance: string): boolean {
  try {
    const base = new URL(instance.endsWith('/') ? instance : instance + '/')
    const actual = new URL(task.marginUrl)
    return safeMarginUrl(instance) !== null && actual.origin === base.origin && actual.pathname === base.pathname + 'reader/' + task.id
  } catch { return false }
}

export async function validatePdf(file: File, limit = MARGIN_MAX_PDF_BYTES): Promise<void> {
  if (file.size === 0 || file.size > Math.min(limit, MARGIN_MAX_PDF_BYTES)) throw new Error('PDF 不能为空且不得超过 10 MiB（或当前服务限制）')
  if (!/\.pdf$/i.test(file.name) || (file.type !== '' && file.type !== 'application/pdf')) throw new Error('请选择 PDF 文件')
  const magic = new Uint8Array(await file.slice(0, 5).arrayBuffer())
  if (String.fromCharCode(...magic) !== '%PDF-') throw new Error('文件没有有效的 PDF 标识')
}

export function importError(error: unknown): string {
  const status = error instanceof MarginApiError ? error.status : undefined
  if (error instanceof Error && error.name === 'AbortError') return '请求超时；请稍后只读检查队列，不会自动重复提交'
  if (error instanceof MarginApiError && error.code === 'instance_changed') return 'Margin 实例已变更，请刷新面板；未向新实例重新提交'
  if (error instanceof MarginApiError && error.code === 'not_configured') return '尚未配置 Margin，请先完成连接配置'
  const labels: Record<number, string> = {
    401: 'Margin 拒绝凭据（401）：请在设置中更新 token',
    403: '导入已禁用，请刷新权限', 409: '重复提交或实例已变更；请只读检查队列，未获得已有任务 ID',
    413: '文件过大', 422: '文件格式无效', 504: '结果不确定：服务可能已接受，请只读检查队列，勿直接重试',
    404: '任务不在当前队列中，状态未知',
  }
  return (status && labels[status]) || (error instanceof Error ? error.message : '请求失败')
}

/** Effect-owned polling controller. GET retries never cause a POST. */
export class ImportSession {
  view: MarginImportView | null = null
  known = new Map<number, MarginImportTask>()
  message = ''
  busy = false
  checking = false
  blocked = new Set<string>()
  private active = false
  private epoch = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private attempts = 0
  private started = 0
  private completedIds = new Set<number>()
  constructor(readonly api: ImportApi, private changed: () => void, private onCompleted: () => void) {}
  get tasks(): MarginImportTask[] {
    const tasks = new Map(this.view?.tasks.slice(0, 20).map(task => [task.id, task]))
    for (const [id, task] of this.known) tasks.set(id, task)
    return [...tasks.values()]
  }
  start(): void {
    this.active = true; this.attempts = 0; this.started = Date.now()
    if (this.view) this.view = { ...this.view, urlAllowed: false, pdfAllowed: false }
    void this.check(false)
  }
  stop(): void { this.active = false; this.epoch++; clearTimeout(this.timer); this.checking = false; this.busy = false }
  private notifyCompleted(tasks: MarginImportTask[]): void {
    for (const task of tasks) if (completed(task) && !this.completedIds.has(task.id)) {
      this.completedIds.add(task.id); this.onCompleted()
    }
  }
  async check(explicit = true): Promise<void> {
    if (!this.active || this.checking) return
    clearTimeout(this.timer)
    let epoch = this.epoch
    this.checking = true; this.changed()
    try {
      const view = await this.api.loadImports()
      if (!this.active || epoch !== this.epoch) return
      if (this.view && this.view.instanceUrl !== view.instanceUrl) {
        this.epoch++; epoch = this.epoch; this.known.clear(); this.blocked.clear(); this.completedIds.clear()
        this.busy = false; this.message = 'Margin 实例已变更；已停止跟踪旧实例'
      }
      const currentEpoch = this.epoch
      this.view = { ...view, tasks: view.tasks.slice(0, 20) }
      const missing: number[] = []
      for (const [id, prior] of this.known) {
        const task = view.tasks.find(item => item.id === id)
        if (task) this.known.set(id, task)
        else { this.known.set(id, { ...prior, status: 'unknown' }); missing.push(id) }
      }
      for (const id of missing.slice(0, 3)) {
        try {
          const receipt = await this.api.loadImportTask(id, view.instanceUrl)
          if (!this.active || currentEpoch !== this.epoch) return
          if (receipt.instanceUrl === view.instanceUrl && receipt.task.id === id) this.known.set(id, receipt.task)
        } catch { /* Missing is unknown, never inferred completion. */ }
      }
      if (!this.active || currentEpoch !== this.epoch) return
      if (explicit) { this.blocked.clear(); this.message = '已只读检查。若结果仍未知，请先在 Margin 核实，避免重复导入。'; this.attempts = 0; this.started = Date.now() }
      this.notifyCompleted(this.tasks)
    } catch (error) {
      if (this.active && epoch === this.epoch) { this.message = importError(error); if (this.view) this.view = { ...this.view, urlAllowed: false, pdfAllowed: false } }
    } finally {
      if (this.active && epoch === this.epoch) { this.checking = false; this.changed(); this.schedule() }
    }
  }
  private schedule(): void {
    if (!this.active) return
    if (this.attempts >= 20 || Date.now() - this.started >= 600000) {
      this.message = '自动检查已停止；结果未知时请只读重新检查，不会自动重新提交。'; this.changed(); return
    }
    const delay = [3000, 6000, 12000, 20000][Math.min(this.attempts++, 3)]
    this.timer = setTimeout(() => { void this.check(false) }, delay)
  }
  async submit(kind: 'url' | 'pdf', input: string | File): Promise<void> {
    const fingerprint = submissionKey(kind, input)
    if (this.busy || this.blocked.has(fingerprint) || !this.active) return
    const view = this.view
    if (!view || !(kind === 'url' ? view.urlAllowed : view.pdfAllowed)) { this.message = '当前未授权导入'; this.changed(); return }
    this.busy = true; this.message = ''; this.changed()
    const epoch = this.epoch
    let posted = false
    try {
      if (kind === 'url') {
        const url = safeMarginUrl(String(input).trim())
        if (!url) throw new Error('请输入完整的 HTTP(S) URL')
        const parsed = new URL(url)
        if (parsed.username || parsed.password) throw new Error('导入链接不能包含用户名或密码')
      }
      if (kind === 'pdf') await validatePdf(input as File, view.maxPdfBytes)
      if (!this.active || epoch !== this.epoch) return
      posted = true
      this.blocked.add(fingerprint)
      const receipt = await (kind === 'url' ? this.api.importUrl(String(input).trim(), view.instanceUrl) : this.api.importPdf(input as File, view.instanceUrl))
      if (!this.active || epoch !== this.epoch) return
      if (receipt.instanceUrl !== view.instanceUrl) { this.blocked.add(fingerprint); this.message = '实例不匹配，结果未知；请重新检查队列'; return }
      if (this.known.size >= 3) this.known.delete(this.known.keys().next().value!)
      this.known.set(receipt.task.id, receipt.task)
      this.blocked.add(fingerprint)
      this.message = '已接受（202），并非导入完成。关闭此面板不会取消后台处理。'
      this.attempts = 0; this.started = Date.now()
      // Completion only comes from a subsequent read, not the acceptance receipt.
      void this.check(false)
    } catch (error) {
      if (this.active && epoch === this.epoch) {
        this.message = importError(error)
        if (posted && !(error instanceof MarginApiError)) this.message = '网络结果不确定；请只读检查队列，不要直接重复提交。'
        if (error instanceof MarginApiError && error.status === 403 && this.view) this.view = { ...this.view, urlAllowed: false, pdfAllowed: false }
      }
    } finally { if (this.active && epoch === this.epoch) { this.busy = false; this.changed() } }
  }
}

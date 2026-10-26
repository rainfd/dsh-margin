import { useEffect, useMemo, useState } from 'react'
import type { MarginImportTask } from '../protocol.ts'
import { ImportSession, completed, submissionKey, taskBelongsToInstance, type ImportApi } from './importModel.ts'
import { safeMarginUrl } from './readerModel.ts'

export function ImportPanel({ api, active, onClose, onCompleted, onOpen }: {
  api: ImportApi; active: boolean; onClose: () => void; onCompleted: () => void
  onOpen: (task: MarginImportTask, instance: string) => Promise<void>
}) {
  const [, redraw] = useState(0)
  const session = useMemo(() => new ImportSession(api, () => redraw(n => n + 1), onCompleted), [api, onCompleted])
  const [url, setUrl] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [openError, setOpenError] = useState('')
  const [opening, setOpening] = useState(false)
  useEffect(() => {
    if (active) session.start()
    return () => session.stop()
  }, [session, active])
  const view = session.view
  const fallback = safeMarginUrl(view?.instanceUrl ?? '')
  const labels = { processing: '处理中', unknown: '未知（需核实）', unprocessed: '已就绪 · 未读', read: '已就绪 · 已读', error: '失败' }
  return <div className="margin-reading__viewport" hidden={!active}>
    <section className="margin-reading__content" aria-label="URL / PDF 导入">
      <header className="margin-reading__head">
        <h1 className="margin-reading__title">URL / PDF 导入</h1>
        <button type="button" className="margin-reading__button" onClick={onClose}>返回阅读（后台导入继续）</button>
      </header>
      <p>仅由你点击提交。接受请求不代表完成；不会自动重新导入失败任务。仅显示最近 20 条及本面板最多 3 条已接受任务。</p>
      <div className="margin-reading__toolbar">
        <label>网页 URL <input className="margin-reading__select" type="url" placeholder="https://…" value={url} onChange={e => setUrl(e.target.value)} /></label>
        <button type="button" className="margin-reading__button" disabled={!view?.urlAllowed || session.busy || !url.trim() || session.blocked.has(submissionKey('url', url))} onClick={() => { void session.submit('url', url) }}>提交 URL</button>
        <label>PDF（最大 10 MiB） <input type="file" accept=".pdf,application/pdf" onChange={e => setFile(e.target.files?.[0] ?? null)} /></label>
        <button type="button" className="margin-reading__button" disabled={!view?.pdfAllowed || session.busy || !file || session.blocked.has(submissionKey('pdf', file))} onClick={() => { if (file) void session.submit('pdf', file) }}>上传 PDF</button>
      </div>
      {(!view?.urlAllowed || !view?.pdfAllowed) && <p role="status">未启用的导入方式不可提交。队列仍可只读查看；权限由服务端实时决定。</p>}
      <div className="margin-reading__toolbar">
        <button type="button" className="margin-reading__button" disabled={session.checking || session.busy} onClick={() => { void session.check(true) }}>只读刷新 / 重新检查</button>
        {fallback && <a href={fallback} target="_blank" rel="noopener noreferrer">前往 Margin 核实</a>}
      </div>
      <p role="status" aria-live="polite">{session.message || (session.checking ? '正在只读检查队列…' : '自动检查有次数和时间上限；关闭面板停止检查，不会取消后台任务。')}</p>
      {openError && <p role="alert">{openError}</p>}
      <ul className="margin-reading__list" aria-label="最近导入队列">
        {session.tasks.map(task => {
          const belongs = !!view && taskBelongsToInstance(task, view.instanceUrl)
          return <li key={task.id} className="margin-reading__item">
            <div className="margin-reading__body"><h2 className="margin-reading__itemTitle">{task.title || task.sourceUrl || `#${task.id}`}</h2><p>#{task.id} · {labels[task.status]} · {task.sourceType}</p>{task.errorMessage && <p>{task.errorMessage}</p>}</div>
            <div className="margin-reading__actions">
              {completed(task) && belongs && <button type="button" className="margin-reading__button" disabled={opening} onClick={() => {
                if (!view) return
                setOpening(true); setOpenError('')
                void onOpen(task, view.instanceUrl).catch(() => setOpenError('无法打开文章或实例已变更，请刷新队列')).finally(() => setOpening(false))
              }}>阅读</button>}
              {belongs && <a href={task.marginUrl} target="_blank" rel="noopener noreferrer">在 Margin 查看</a>}
            </div>
          </li>
        })}
      </ul>
      {view && session.tasks.length === 0 && <p>最近队列为空；缺席不代表已完成。</p>}
    </section>
  </div>
}

/**
 * dsh-margin — browser half. Registers the reading-list sidebar panel and the
 * settings card on the plugin detail page.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the 'main' slot contract (panels live in the layout service).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the sidebar panellist slot contract.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { MarginApi } from './api.ts'
import { AnnotationPanel } from './AnnotationPanel.tsx'
import { SavePanel } from './SavePanel.tsx'
import { AiPanel } from './AiPanel.tsx'
import { ReadingList, ReadingListIcon, type ReadingListFace } from './ReadingList.tsx'
import { MarginSettingsCard, type MarginSettingsFace } from './MarginSettingsCard.tsx'
import { zh, type MarginKey } from './locales.ts'

/** Locale namespace this plugin owns. */
const NS = 'dsh-margin'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** dsh-margin surface copy. */
    'dsh-margin': MarginKey
  }
}

/** Services used by the browser plugin. */
export const inject = ['slots', 'locale']

/** Mount the Margin surfaces. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en: zh }), 'dsh-margin: dictionaries')
  const t = ctx.locale.bind(NS)

  const api = new MarginApi()
  const readingListFace: ReadingListFace = {
    // Optional AI assistant: the capability GET decides whether anything shows.
    // Only the two AI routes are reachable from here — no status/save method, so
    // the panel cannot change Margin state even by mistake.
    ai: {
      loadCapability: () => api.loadAiCapability(),
      run: (request, signal) => api.runAi(request, signal),
      Panel: AiPanel,
    },
    // Optional highlights and notes: only the annotation routes are reachable
    // here, so the panel has no reading-status, import or AI method at all.
    annotations: {
      loadAnnotations: (id, instanceUrl) => api.loadAnnotations(id, instanceUrl),
      createHighlight: input => api.createHighlight(input),
      linkHighlight: (highlightId, noteId, instanceUrl) => api.linkHighlight(highlightId, noteId, instanceUrl),
      deleteHighlight: input => api.deleteHighlight(input),
      createNote: (candidateId, content, instanceUrl) => api.createNote(candidateId, content, instanceUrl),
      updateNote: (candidateId, noteId, content, expectedContent, instanceUrl) => api.updateNote(candidateId, noteId, content, expectedContent, instanceUrl),
      deleteNote: (candidateId, noteId, content, instanceUrl) => api.deleteNote(candidateId, noteId, content, instanceUrl),
      Panel: AnnotationPanel,
    },
    // Save-to-Trilium: only the two save routes. The face carries no status,
    // import, annotation or AI method, so the panel cannot do anything else.
    save: {
      loadSaveState: (id, instanceUrl) => api.loadSaveState(id, instanceUrl),
      saveToTrilium: (candidateId, instanceUrl, marginUrl) => api.saveToTrilium(candidateId, instanceUrl, marginUrl),
      Panel: SavePanel,
    },
    imports: {
      loadImports: () => api.loadImports(),
      importUrl: (url, instanceUrl) => api.importUrl(url, instanceUrl),
      importPdf: (file, instanceUrl) => api.importPdf(file, instanceUrl),
      loadImportTask: (id, instanceUrl) => api.loadImportTask(id, instanceUrl),
    },
    // Source/credential management: read is always allowed, writes are gated
    // by the host and re-checked on every mutation.
    // Local scroll position only: no status/import method is exposed here, so
    // the reader structurally cannot turn "scrolled to the end" into "read".
    progress: {
      loadProgress: limit => api.loadProgress(limit),
      saveProgress: input => api.saveProgress(input),
      clearProgress: key => api.clearProgress(key),
    },
    sources: {
      loadManagement: () => api.loadManagement(),
      createSource: (feedUrl, label, intervalMinutes, instanceUrl) => api.createSource(feedUrl, label, intervalMinutes, instanceUrl),
      setSourceStatus: (id, status, instanceUrl) => api.setSourceStatus(id, status, instanceUrl),
      fetchSource: (id, instanceUrl) => api.fetchSource(id, instanceUrl),
      deleteSource: (id, confirmOrigin, instanceUrl) => api.deleteSource(id, confirmOrigin, instanceUrl),
      createCredential: (domain, cookie, instanceUrl) => api.createCredential(domain, cookie, instanceUrl),
      deleteCredential: (id, domain, instanceUrl) => api.deleteCredential(id, domain, instanceUrl),
    },
    loadList: options => api.loadReadingList(options),
    loadCandidate: id => api.loadCandidate(id),
    setCandidateStatus: (id, status, marginUrl) => api.setCandidateStatus(id, status, marginUrl),
  }
  const settingsFace: MarginSettingsFace = { api }

  // External bundles own their configuration on the Plugins detail page.
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: 'dsh-margin-config',
    locale: NS,
    inject: (): MarginSettingsFace => settingsFace,
  }, MarginSettingsCard))

  // Sidebar panel: reading backlog with explicitly gated reading-status writes.
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: 'margin-reading-list',
    order: 40,
    locale: NS,
    label: () => t('list.title'),
  }, ReadingListIcon))

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: 'margin-reading-list',
    locale: NS,
    inject: (): ReadingListFace => readingListFace,
  }, ReadingList))
}

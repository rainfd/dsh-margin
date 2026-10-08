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
    loadList: options => api.loadReadingList(options),
  }
  const settingsFace: MarginSettingsFace = { api }

  // External bundles own their configuration on the Plugins detail page.
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: 'dsh-margin-config',
    locale: NS,
    inject: (): MarginSettingsFace => settingsFace,
  }, MarginSettingsCard))

  // Sidebar panel: the reading backlog. Read-only in this stage.
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

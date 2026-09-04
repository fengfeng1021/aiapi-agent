/**
 * MoA (Mixture-of-Agents) settings plugin, browser half.
 * Registers the MoA page as `settings.section` at order 15.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'

import { MoaSection } from './MoaSection.tsx'
import type { MoaSectionInjected } from './MoaSection.tsx'
import { MoaSettingsController } from './store.ts'
import { en, zh, type MoaKey } from './locales.ts'

export type { MoaSectionInjected, MoaSectionProps } from './MoaSection.tsx'
export type { MoaKey } from './locales.ts'
export type { MoaModelSlot, MoaPreset, MoaSettings } from './types.ts'
export { MoaSettingsController } from './store.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The MoA page copy. */
    'settings.moa': MoaKey
  }
}

const NS = 'settings.moa'

export const inject = [
  'slots', 'locale', 'remote',
]

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-moa: copy dictionaries')

  const controller = new MoaSettingsController(ctx)
  const t = ctx.locale.bind(NS) as MoaSectionInjected['t']

  const injected = (): MoaSectionInjected => ({
    controller,
    t,
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'moa',
    order: 15,
    label: () => t('nav'),
    inject: injected,
  }, MoaSection))
}

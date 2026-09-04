import { BrandWordmark } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import css from './Brand.module.css'

/**
 * Render the official mark with the presentation requested by its host surface.
 * @param props - Host-supplied mark presentation.
 * @returns the official Aiapi mark with light/dark support.
 */
export function OfficialBrandMark({ size = 24 }: SidebarBrandMarkOwnerProps) {
  return (
    <span className={css.markContainer} style={{ width: size, height: size }}>
      <img src="/logo.png" width={size} height={size} alt="Aiapi" className={css.logoLight} />
      <img src="/logo-dark.png" width={size} height={size} alt="Aiapi" className={css.logoDark} />
    </span>
  )
}

/**
 * Render the official name artwork without its independently slotted mark.
 * @returns the official name wordmark.
 */
export function OfficialBrandName() {
  return <BrandWordmark includeMark={false} />
}

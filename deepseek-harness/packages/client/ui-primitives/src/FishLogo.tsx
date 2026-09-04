import type { IconProps } from './icons/props.ts'
import clsx from 'clsx'
import css from './FishLogo.module.css'

/** Native viewBox of Aiapi logo. */
export const FISH_LOGO_VIEWBOX = { width: 100, height: 100 }

/** Path data for compatibility with consumers. */
export const FISH_LOGO_PATH = ''

/**
 * Render the Aiapi brand logo (supports both light and dark mode logos).
 * @param props.size - width/height in px (default 24).
 * @param props.className - extra class for layout placement.
 * @returns the logo element.
 */
export function FishLogo({ size = 24, className }: IconProps) {
  return (
    <span className={clsx(css.root, className)} style={{ width: size, height: size }}>
      <img
        src="/logo.png"
        width={size}
        height={size}
        alt="Aiapi"
        className={css.lightLogo}
        style={{ width: size, height: size }}
      />
      <img
        src="/logo-dark.png"
        width={size}
        height={size}
        alt="Aiapi"
        className={css.darkLogo}
        style={{ width: size, height: size }}
      />
    </span>
  )
}

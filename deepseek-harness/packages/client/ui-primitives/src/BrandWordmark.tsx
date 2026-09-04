import type { IconProps } from './icons/props.ts'
import { FishLogo } from './FishLogo.tsx'

/** Display options for the official brand wordmark. */
export interface BrandWordmarkProps extends IconProps {
  /** Whether to include the leading whale mark; defaults to true. */
  includeMark?: boolean | undefined
}

/**
 * Render the full brand wordmark for Aiapi.
 * @param props.size - height in px (default 24).
 * @param props.className - extra class for layout placement.
 * @param props.includeMark - whether to include the leading mark.
 * @returns the wordmark component.
 */
export function BrandWordmark({ size = 24, className, includeMark = true }: BrandWordmarkProps) {
  return (
    <span
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: `${Math.round(size * 0.35)}px`,
        height: `${size}px`,
        fontWeight: 700,
        fontSize: `${Math.round(size * 0.85)}px`,
        lineHeight: 1,
        letterSpacing: '-0.02em',
        color: 'currentColor',
        userSelect: 'none',
      }}
      aria-hidden="true"
    >
      {includeMark && <FishLogo size={size} />}
      <span>Aiapi Agent</span>
    </span>
  )
}


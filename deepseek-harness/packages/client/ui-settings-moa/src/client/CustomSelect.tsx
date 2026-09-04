/**
 * Polished, accessible custom dropdown component with search filter,
 * keyboard navigation, and refined UX states.
 */

import { useState, useRef, useEffect, useMemo } from 'react'
import { IconCheckOutline16, IconSearchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './CustomSelect.module.css'

export interface SelectOption {
  value: string
  label: string
  badge?: string | undefined
  description?: string | undefined
}

export interface CustomSelectProps {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  placeholder?: string
  disabled?: boolean
  disabledReason?: string
  className?: string
  searchable?: boolean
}

export function CustomSelect({
  value,
  onChange,
  options,
  placeholder = '請選擇...',
  disabled = false,
  disabledReason,
  className = '',
  searchable = true,
}: CustomSelectProps) {
  const [open, setOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState(0)

  const containerRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const selectedOption = options.find(o => o.value === value)

  // Filter options by search query
  const filteredOptions = useMemo(() => {
    if (!searchQuery.trim()) return options
    const q = searchQuery.toLowerCase().trim()
    return options.filter(
      o => o.label.toLowerCase().includes(q) || (o.badge && o.badge.toLowerCase().includes(q))
    )
  }, [options, searchQuery])

  // Focus search input on open
  useEffect(() => {
    if (open) {
      setSearchQuery('')
      setHighlightedIndex(0)
      if (options.length > 5) {
        setTimeout(() => searchInputRef.current?.focus(), 50)
      }
    }
  }, [open, options.length])

  // Close on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [open])

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        setOpen(true)
      }
      return
    }

    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightedIndex(prev => (prev + 1) % Math.max(1, filteredOptions.length))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightedIndex(prev => (prev - 1 + filteredOptions.length) % Math.max(1, filteredOptions.length))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const target = filteredOptions[highlightedIndex]
      if (target) {
        onChange(target.value)
        setOpen(false)
      }
    }
  }

  const effectivePlaceholder = disabled && disabledReason ? disabledReason : placeholder

  return (
    <div
      ref={containerRef}
      className={`${css.selectContainer} ${disabled ? css.disabled : ''} ${className}`}
      onKeyDown={handleKeyDown}
    >
      <button
        type="button"
        disabled={disabled}
        className={`${css.trigger} ${open ? css.triggerOpen : ''} ${!selectedOption ? css.triggerPlaceholder : ''}`}
        onClick={() => setOpen(prev => !prev)}
        title={disabled && disabledReason ? disabledReason : undefined}
      >
        <span className={css.valueText}>
          {selectedOption ? selectedOption.label : effectivePlaceholder}
        </span>
        {selectedOption?.badge && (
          <span className={css.triggerBadge}>{selectedOption.badge}</span>
        )}
        <svg
          className={`${css.chevron} ${open ? css.chevronOpen : ''}`}
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div className={css.dropdownMenu}>
          {/* Search bar when options > 5 */}
          {searchable && options.length > 5 && (
            <div className={css.searchBox}>
              <div className={css.searchIcon}>
                <IconSearchOutline16 size={13} />
              </div>
              <input
                ref={searchInputRef}
                type="text"
                className={css.searchInput}
                placeholder="搜尋選項..."
                value={searchQuery}
                onChange={e => {
                  setSearchQuery(e.target.value)
                  setHighlightedIndex(0)
                }}
                onClick={e => e.stopPropagation()}
              />
              {searchQuery && (
                <button
                  type="button"
                  className={css.clearSearchBtn}
                  onClick={e => {
                    e.stopPropagation()
                    setSearchQuery('')
                    searchInputRef.current?.focus()
                  }}
                >
                  ✕
                </button>
              )}
            </div>
          )}

          <div ref={listRef} className={css.optionsList}>
            {filteredOptions.length === 0 ? (
              <div className={css.emptyMessage}>
                {searchQuery ? '無相符結果' : '無可用項目'}
              </div>
            ) : (
              filteredOptions.map((opt, idx) => {
                const isSelected = opt.value === value
                const isHighlighted = idx === highlightedIndex
                return (
                  <div
                    key={opt.value}
                    className={`${css.optionItem} ${isSelected ? css.optionSelected : ''} ${isHighlighted ? css.optionHighlighted : ''}`}
                    onClick={() => {
                      onChange(opt.value)
                      setOpen(false)
                    }}
                    onMouseEnter={() => setHighlightedIndex(idx)}
                  >
                    <div className={css.optionMain}>
                      <span className={css.optionLabel}>{opt.label}</span>
                      {opt.description && (
                        <span className={css.optionDesc}>{opt.description}</span>
                      )}
                    </div>
                    <div className={css.optionRight}>
                      {opt.badge && <span className={css.optionBadge}>{opt.badge}</span>}
                      {isSelected && (
                        <span className={css.checkIcon}>
                          <IconCheckOutline16 size={13} />
                        </span>
                      )}
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}

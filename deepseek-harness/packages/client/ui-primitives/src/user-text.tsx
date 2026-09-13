/**
 * Display projection of reference forms in sent user text (bubble and queue
 * rows). The logged model text remains the single truth; this is presentation
 * only, and every part renders inline so the consumer's line box owns
 * wrapping: the chat bubble wraps long file names at any character, while the
 * queue preview's nowrap/ellipsis keeps one line. Five decoration sources, by
 * precedence: the wire session form `@[label](dsh-session:...)` folds to its
 * label; exact session labels supplied by an adjacent recall decorate their
 * bare `@label` mention; and plain `/name` / `@name` word-boundary tokens
 * decorate by shape alone (sent tokens were validated at compose time); bare
 * URLs linkify, backtick spans read as code, and hex hashes read as constants.
 */
import type { ReactNode } from 'react'
import { ReferenceIcon } from './ReferenceIcon.tsx'
import css from './user-text.module.css'

/** The wire form a session chip serializes to; label is the display text. */
const SESSION_WIRE_RE = /@\[([^\]\n]+)\]\(dsh-session:[^)\s]+\)/gu

/** Bare http(s) URLs following whitespace or an opening bracket. */
const URL_RE = /(^|[\s(（>《"'])(https?:\/\/[^\s<>()"（）]+)/gu
/** Trailing sentence punctuation that never belongs to a URL. */
const URL_TAIL_RE = /[.,;:!?，。；：！？、~"')\]}>]+$/u
/** Single-backtick code spans without newlines. */
const CODE_RE = /`([^`\n]+)`/gu
/** Hex version hashes: 7-40 hex chars mixing letters and digits. */
const HASH_RE = /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{7,40}\b/gu

interface DecorationRange {
  readonly start: number
  readonly end: number
  /** Matched source text (hover title). */
  readonly label: string
  readonly kind: 'session' | 'plain' | 'link' | 'code' | 'hash'
  /** Pre-resolved display text (wire folds); derived from label when absent. */
  readonly display?: string
}

/**
 * Split one sent text into inline plain runs and reference chips.
 * @param text - the logged model text of the message or queue row.
 * @param sessionLabels - exact session mention labels associated by an adjacent recall.
 * @returns inline nodes covering the whole text.
 */
export function projectUserText(text: string, sessionLabels: readonly string[]): ReactNode {
  const ranges: DecorationRange[] = []
  SESSION_WIRE_RE.lastIndex = 0
  let wire: RegExpExecArray | null
  while ((wire = SESSION_WIRE_RE.exec(text)) !== null) {
    ranges.push({
      start: wire.index,
      end: wire.index + wire[0].length,
      label: wire[0],
      kind: 'session',
      display: wire[1] as string, // non-optional capture in SESSION_WIRE_RE
    })
  }
  for (const rawLabel of [...new Set(sessionLabels)].sort((a, b) => b.length - a.length)) {
    const label = `@${rawLabel}`
    let start = text.indexOf(label)
    while (start >= 0) {
      ranges.push({ start, end: start + label.length, label, kind: 'session' })
      start = text.indexOf(label, start + label.length)
    }
  }
  const re = /(^|\s)(\/[\w-]+|@"[^"\n]+"|@[^\s]+)/gu
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const tokenStart = m.index + (m[1] as string).length // (^|\s) captures '' at line start
    const rawLabel = m[2] as string // non-optional alternation capture
    const label = rawLabel.startsWith('@"')
      ? rawLabel
      : rawLabel.replace(/[.,;:!?，。；：！？]+$/gu, '')
    if (label.length <= 1) continue
    ranges.push({ start: tokenStart, end: tokenStart + label.length, label, kind: 'plain' })
  }
  URL_RE.lastIndex = 0
  let u: RegExpExecArray | null
  while ((u = URL_RE.exec(text)) !== null) {
    const raw = u[2] as string
    const url = raw.replace(URL_TAIL_RE, '')
    if (url.length === 0) continue
    const urlStart = u.index + (u[1] as string).length
    ranges.push({ start: urlStart, end: urlStart + url.length, label: url, kind: 'link' })
  }
  CODE_RE.lastIndex = 0
  let c: RegExpExecArray | null
  while ((c = CODE_RE.exec(text)) !== null) {
    ranges.push({ start: c.index, end: c.index + c[0].length, label: c[0], kind: 'code', display: c[1] as string })
  }
  HASH_RE.lastIndex = 0
  let h: RegExpExecArray | null
  while ((h = HASH_RE.exec(text)) !== null) {
    ranges.push({ start: h.index, end: h.index + h[0].length, label: h[0], kind: 'hash' })
  }
  const rankOf = (range: DecorationRange): number => range.kind === 'session' ? 0 : range.kind === 'link' ? 1 : range.kind === 'code' || range.kind === 'hash' ? 2 : 3
  ranges.sort((a, b) => a.start - b.start || rankOf(a) - rankOf(b) || b.end - a.end)
  const parts: ReactNode[] = []
  let cursor = 0
  const pushPlain = (from: number, to: number): void => {
    parts.push(<span key={`t${from}`} className={css.plainRun}>{text.slice(from, to)}</span>)
  }
  for (const range of ranges) {
    if (range.start < cursor) continue
    const { start: tokenStart, end, label, kind } = range
    if (tokenStart > cursor) pushPlain(cursor, tokenStart)
    const referenceKind = kind === 'session'
      ? 'session'
      : label.startsWith('@')
        ? label.endsWith('/') ? 'folder' : 'file'
        : undefined
    const displayLabel = range.display
      ?? (referenceKind === undefined
        ? label
        : referenceKind === 'session'
          ? label.slice(1)
          : label.slice(1).replace(/^"|"$/gu, '').split(/[\\/]/u).filter(Boolean).at(-1) ?? label.slice(1))
    if (kind === 'link') {
      parts.push(
        <a key={tokenStart} className={css.userLink} href={label} target='_blank' rel='noreferrer noopener' title={label}>{displayLabel}</a>,
      )
      cursor = end
      continue
    }
    if (kind === 'code' || kind === 'hash') {
      parts.push(
        <code key={tokenStart} className={kind === 'code' ? css.userCode : css.userHash}>{displayLabel}</code>,
      )
      cursor = end
      continue
    }
    parts.push(
      <span
        key={tokenStart}
        className={css.refChip}
        data-ref-chip={referenceKind ?? 'skill'}
        title={label}
      >
        {referenceKind !== undefined && (
          <ReferenceIcon kind={referenceKind} size={16} className={css.refIcon} />
        )}
        {displayLabel}
      </span>,
    )
    cursor = end
  }
  if (parts.length === 0) return <span className={css.plainRun}>{text}</span>
  if (cursor < text.length) pushPlain(cursor, text.length)
  return <>{parts}</>
}

/** One dropped-file reference a submission appended to its prompt text. */
export interface UserFileRef {
  /** Absolute path delivered to the model (without the leading `@`). */
  readonly path: string
  /** Basename for attachment presentation. */
  readonly name: string
}

/** One submit-appended reference line: `@` followed by an absolute host path. */
const FILE_REF_LINE_RE = /^@((?:[A-Za-z]:[\\/]|[\\/]).*)$/u

/**
 * Split the consecutive absolute-path reference lines a submission appended
 * to the end of its text (desktop file drops ride the prompt as references,
 * never as a separate block). Consumers lift the files out for attachment
 * presentation — the chat bubble gives each its own bubble, and the turn-rail
 * preview drops them so a path never shows as prose. Typed mentions elsewhere
 * (relative paths, prose) stay in the text.
 * @param text - one sent text or text block.
 * @returns the remaining text and the extracted files in append order.
 */
export function splitUserFileRefs(text: string): {
  readonly text: string
  readonly files: readonly UserFileRef[]
} {
  const lines = text.split('\n')
  const files: UserFileRef[] = []
  while (lines.length > 0) {
    const match = FILE_REF_LINE_RE.exec(lines[lines.length - 1] as string)
    if (match === null) break
    const path = match[1] as string
    lines.pop()
    files.unshift({ path, name: path.replace(/^.*[\\/]/u, '') })
  }
  return { text: lines.join('\n'), files }
}

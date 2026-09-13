/** Plain-text file intake for drops and pastes: detection, capped reads, model-facing blocks. */

import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationKey } from './locales.ts'

/** Per-file text cap: larger files truncate with a marker instead of flooding the composer. */
export const MAX_TEXT_FILE_BYTES = 64 * 1024

/** Lowercase extensions treated as plain text when the MIME type is empty or generic. */
const TEXT_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  'txt', 'text', 'md', 'markdown', 'mdown', 'json', 'jsonl', 'jsonc',
  'css', 'scss', 'less', 'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx',
  'mts', 'cts', 'py', 'pyw', 'rb', 'go', 'rs', 'java', 'c', 'h',
  'cc', 'cpp', 'hpp', 'cxx', 'cs', 'html', 'htm', 'xml', 'yml',
  'yaml', 'toml', 'ini', 'cfg', 'conf', 'log', 'csv', 'tsv',
  'sh', 'bash', 'zsh', 'sql', 'graphql', 'gql', 'vue', 'svelte',
  'php', 'swift', 'kt', 'kts', 'scala', 'r', 'pl', 'pm', 'lua',
  'vim', 'properties', 'gradle', 'cmake',
])

/** Exact lowercase basenames treated as plain text (extensionless or dotfiles). */
const TEXT_FILE_NAMES: ReadonlySet<string> = new Set([
  'dockerfile', 'makefile', 'gemfile', 'rakefile',
  '.gitignore', '.dockerignore', '.npmignore', '.env',
])

/** Non-`text/*` MIME values that still carry plain text. */
const TEXT_MIME_TYPES: ReadonlySet<string> = new Set([
  'application/json',
  'application/javascript',
  'application/ecmascript',
  'application/xml',
  'application/x-sh',
  'application/x-yaml',
  'application/yaml',
  'application/x-toml',
  'application/toml',
  'application/sql',
  'application/graphql',
])

/** Minimal file face the intake needs (lets tests pass plain object literals). */
export interface TextCandidateFile {
  readonly type: string
  readonly name: string
}

/**
 * Whether a dropped or pasted file reads as plain text. Images and unknown
 * binaries are never text: images keep the vision path, everything else falls
 * through to the host rejection.
 * @param file - browser file (or its name/type face).
 * @returns true for text MIME types and known text extensions/names.
 */
export function isTextFile(file: TextCandidateFile): boolean {
  if (file.type.startsWith('text/')) return true
  if (TEXT_MIME_TYPES.has(file.type)) return true
  const name = file.name.toLowerCase()
  if (TEXT_FILE_NAMES.has(name)) return true
  const dot = name.lastIndexOf('.')
  if (dot > 0) return TEXT_FILE_EXTENSIONS.has(name.slice(dot + 1))
  return false
}

/** Text read of one file, byte-capped with a truncation flag. */
export interface TextFileContent {
  /** Verbatim browser file name for headers and diagnostics. */
  readonly name: string
  /** Decoded text, sliced to MAX_TEXT_FILE_BYTES of the source. */
  readonly text: string
  /** Whether the source exceeded the cap. */
  readonly truncated: boolean
}

/**
 * Read one file as text, byte-capped. Slicing the blob (not the string)
 * keeps the cap exact; a cut multibyte tail degrades to one replacement
 * character, which the truncation marker already discloses.
 * @param file - browser file to read.
 * @returns name plus capped text.
 */
export async function readTextFile(file: File): Promise<TextFileContent> {
  const truncated = file.size > MAX_TEXT_FILE_BYTES
  const slice = truncated ? file.slice(0, MAX_TEXT_FILE_BYTES) : file
  return {
    name: file.name,
    text: await slice.text(),
    truncated,
  }
}

/**
 * Render one read as a model-facing fenced block: filename header, verbatim
 * content, explicit end marker so trailing composer prose stays outside it.
 * @param t - conversation-namespace translate.
 * @param content - capped read to render.
 * @returns block text ready to insert at the caret.
 */
export function formatTextAttachment(
  t: Translate<ConversationKey>,
  content: TextFileContent,
): string {
  const end = content.truncated
    ? t('file.textEndTruncated', { name: content.name })
    : t('file.textEnd', { name: content.name })
  return `${t('file.textHeader', { name: content.name })}\n${content.text}\n${end}`
}

/** Split one dropped/pasted batch into images, plain-text files, and the rejected rest. */
export interface PartitionedFiles {
  readonly images: File[]
  readonly texts: File[]
  readonly others: File[]
}

/**
 * Partition one intake batch by kind. The image predicate stays with the
 * caller (media allow-list when projected, `image/*` otherwise) so this
 * helper owns no limit policy.
 * @param files - dropped or pasted batch in event order.
 * @param isImage - whether a file rides the vision path.
 * @returns the three lanes, each in event order.
 */
export function partitionFiles(
  files: readonly File[],
  isImage: (file: File) => boolean,
): PartitionedFiles {
  const images: File[] = []
  const texts: File[] = []
  const others: File[] = []
  for (const file of files) {
    if (isImage(file)) images.push(file)
    else if (isTextFile(file)) texts.push(file)
    else others.push(file)
  }
  return { images, texts, others }
}

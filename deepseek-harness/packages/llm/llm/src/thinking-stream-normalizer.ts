/**
 * Universal Zero-Maintenance Streaming Thinking Normalizer.
 *
 * Normalizes reasoning content from:
 * 1. Dedicated wire fields (reasoning_content, reasoning, thinking, thought)
 * 2. In-band text tags (<think>, <thought>, <reasoning>, [THINK], [THINKING])
 *
 * Features:
 * - Streaming token-split tolerance (e.g. '<th' + 'ink>').
 * - Zero delay: non-tag text is flushed immediately without buffering.
 * - Automatic stripping of tag markers.
 * - Leading whitespace/newline cleanup after thinking close tags.
 * - Handles arbitrary token splits across network chunk boundaries.
 *
 * @module @deepseek-ai/dsh-llm/thinking-stream-normalizer
 */

export interface NormalizedChunkPart {
  type: 'reasoning' | 'text'
  text: string
}

export const KNOWN_THINKING_TAGS = ['think', 'thinking', 'thought', 'reasoning'] as const

export class StreamingThinkingNormalizer {
  private mode: 'text' | 'reasoning' = 'text'
  private buffer = ''
  private justClosedThinking = false
  private tagNames: string[]

  constructor(options?: { initialMode?: 'text' | 'reasoning'; extraTags?: string[] }) {
    this.mode = options?.initialMode ?? 'text'
    this.tagNames = [...KNOWN_THINKING_TAGS, ...(options?.extraTags ?? [])].map(t => t.toLowerCase())
  }

  get currentMode(): 'text' | 'reasoning' {
    return this.mode
  }

  /**
   * Directly switch mode (e.g. when wire fields indicate reasoning).
   */
  setMode(mode: 'text' | 'reasoning'): void {
    this.mode = mode
  }

  /**
   * Process an incoming text delta that may contain in-band thinking tags.
   */
  feedContent(delta: string): NormalizedChunkPart[] {
    if (!delta) return []

    const results: NormalizedChunkPart[] = []
    const emit = (type: 'reasoning' | 'text', text: string) => {
      if (!text) return
      const last = results[results.length - 1]
      if (last && last.type === type) {
        last.text += text
      } else {
        results.push({ type, text })
      }
    }

    const input = this.buffer + delta
    this.buffer = ''

    let i = 0
    const len = input.length

    while (i < len) {
      if (this.justClosedThinking) {
        // Strip immediate newlines/whitespace after </think>
        if (input[i] === '\n' || input[i] === '\r') {
          i++
          continue
        }
        this.justClosedThinking = false
      }

      const char = input[i]
      if (char === undefined) break

      // Check if we hit the start of a potential tag: '<' or '['
      if (char === '<' || char === '[') {
        const isBracket = char === '['
        const remainder = input.slice(i)

        // Does remainder match a full tag?
        const tagMatch = this.matchFullTag(remainder, isBracket)
        if (tagMatch) {
          i += tagMatch.length
          if (tagMatch.isClosing) {
            this.mode = 'text'
            this.justClosedThinking = true
          } else {
            this.mode = 'reasoning'
          }
          continue
        }

        // Is remainder a potential prefix of a tag?
        if (this.isTagPrefix(remainder, isBracket)) {
          // It could be a partial tag split across chunks!
          // Buffer it and wait for next chunk.
          this.buffer = remainder
          break
        }

        // Not a tag and not a tag prefix -> emit char
        emit(this.mode, char)
        i++
      } else {
        emit(this.mode, char)
        i++
      }
    }

    return results
  }

  /**
   * Flush any remaining buffer at the end of the stream.
   */
  flush(): NormalizedChunkPart[] {
    if (!this.buffer) return []
    const remaining = this.buffer
    this.buffer = ''
    return [{ type: this.mode, text: remaining }]
  }

  private matchFullTag(
    str: string,
    isBracket: boolean
  ): { isClosing: boolean; length: number } | null {
    const openChar = isBracket ? '\\[' : '<'
    const closeChar = isBracket ? '\\]' : '>'
    // Matches e.g. <think>, </think>, [THINK], [/THINK]
    const tagRegex = new RegExp(`^${openChar}(\\/?)(${this.tagNames.join('|')})${closeChar}`, 'i')
    const match = str.match(tagRegex)
    if (match) {
      return {
        isClosing: match[1] === '/',
        length: match[0].length,
      }
    }
    return null
  }

  private isTagPrefix(str: string, isBracket: boolean): boolean {
    const maxTagLen = 14 // e.g. '</reasoning>' is 12
    if (str.length > maxTagLen) return false

    const openChar = isBracket ? '[' : '<'
    if (!str.startsWith(openChar)) return false

    const rest = str.slice(1).toLowerCase()
    const isClose = rest.startsWith('/')
    const afterSlash = isClose ? rest.slice(1) : rest

    // Empty afterSlash matches because any tag begins after opening delimiter
    if (afterSlash === '') return true

    // Only alphabet characters are allowed in tag names
    if (!/^[a-z]+$/.test(afterSlash)) return false

    // Is afterSlash a prefix of any valid tag?
    return this.tagNames.some(tag => tag.startsWith(afterSlash))
  }
}

/**
 * Universal Sniffer: extract reasoning from any standard or non-standard wire delta fields.
 * Supports:
 * - DeepSeek official / SiliconFlow: `delta.reasoning_content`
 * - OpenRouter (Claude 3.7 Thinking, o-series, R1): `delta.reasoning` / `delta.reasoning_content`
 * - Anthropic adapters: `delta.thinking`
 * - Gemini adapters: `delta.thought`
 * - Choice-level fields: `choice.reasoning_content` / `choice.reasoning`
 */
export function extractWireReasoningDelta(choiceOrDelta: unknown): string | undefined {
  if (!choiceOrDelta || typeof choiceOrDelta !== 'object') return undefined
  const obj = choiceOrDelta as Record<string, any>
  const delta = obj.delta && typeof obj.delta === 'object' ? obj.delta : obj

  const candidate =
    delta.reasoning_content ??
    delta.reasoning ??
    delta.thinking ??
    delta.thought ??
    obj.reasoning_content ??
    obj.reasoning ??
    obj.message?.reasoning_content ??
    obj.message?.reasoning

  if (typeof candidate === 'string') {
    return candidate.length > 0 ? candidate : undefined
  }
  if (candidate && typeof candidate === 'object') {
    if (typeof candidate.text === 'string' && candidate.text.length > 0) return candidate.text
    if (typeof candidate.content === 'string' && candidate.content.length > 0) return candidate.content
  }
  return undefined
}

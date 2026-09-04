import { describe, expect, it } from 'vitest'
import {
  StreamingThinkingNormalizer,
  extractWireReasoningDelta,
} from '../src/thinking-stream-normalizer.ts'

describe('extractWireReasoningDelta', () => {
  it('extracts delta.reasoning_content (DeepSeek official / SiliconFlow)', () => {
    const choice = { delta: { reasoning_content: 'analyzing edge cases' } }
    expect(extractWireReasoningDelta(choice)).toBe('analyzing edge cases')
  })

  it('extracts delta.reasoning (OpenRouter Claude 3.7 / o3-mini / Groq)', () => {
    const choice = { delta: { reasoning: 'checking performance requirements' } }
    expect(extractWireReasoningDelta(choice)).toBe('checking performance requirements')
  })

  it('extracts delta.thinking (Anthropic adapters)', () => {
    const choice = { delta: { thinking: 'synthesizing solution' } }
    expect(extractWireReasoningDelta(choice)).toBe('synthesizing solution')
  })

  it('extracts delta.thought (Gemini adapters)', () => {
    const choice = { delta: { thought: 'reviewing inputs' } }
    expect(extractWireReasoningDelta(choice)).toBe('reviewing inputs')
  })

  it('extracts object reasoning wrappers ({ text: string })', () => {
    const choice = { delta: { reasoning: { text: 'object reasoning chunk' } } }
    expect(extractWireReasoningDelta(choice)).toBe('object reasoning chunk')
  })

  it('extracts choice-level reasoning fields', () => {
    const choice = { reasoning_content: 'fallback choice level' }
    expect(extractWireReasoningDelta(choice)).toBe('fallback choice level')
  })

  it('returns undefined when reasoning is absent or empty', () => {
    expect(extractWireReasoningDelta({ delta: { content: 'hello' } })).toBeUndefined()
    expect(extractWireReasoningDelta({ delta: { reasoning_content: '' } })).toBeUndefined()
    expect(extractWireReasoningDelta(null)).toBeUndefined()
  })
})

describe('StreamingThinkingNormalizer', () => {
  it('normalizes single-chunk <think> tags into reasoning and text', () => {
    const normalizer = new StreamingThinkingNormalizer()
    const parts = normalizer.feedContent('<think>Plan architecture</think>Here is the code.')
    expect(parts).toEqual([
      { type: 'reasoning', text: 'Plan architecture' },
      { type: 'text', text: 'Here is the code.' },
    ])
  })

  it('handles arbitrary token-split opening tags across chunks', () => {
    const normalizer = new StreamingThinkingNormalizer()
    const p1 = normalizer.feedContent('<th')
    expect(p1).toEqual([]) // buffered

    const p2 = normalizer.feedContent('ink>Starting analysis')
    expect(p2).toEqual([{ type: 'reasoning', text: 'Starting analysis' }])

    const p3 = normalizer.feedContent(' of algorithm.</think>Final result')
    expect(p3).toEqual([
      { type: 'reasoning', text: ' of algorithm.' },
      { type: 'text', text: 'Final result' },
    ])
  })

  it('handles arbitrary token-split closing tags across chunks', () => {
    const normalizer = new StreamingThinkingNormalizer()
    normalizer.feedContent('<think>Thought 1')
    const p2 = normalizer.feedContent(' Thought 2</th')
    expect(p2).toEqual([{ type: 'reasoning', text: ' Thought 2' }])

    const p3 = normalizer.feedContent('ink>Result text')
    expect(p3).toEqual([{ type: 'text', text: 'Result text' }])
  })

  it('handles multi-chunk fragmented split (< + th + in + k>)', () => {
    const normalizer = new StreamingThinkingNormalizer()
    expect(normalizer.feedContent('<')).toEqual([])
    expect(normalizer.feedContent('th')).toEqual([])
    expect(normalizer.feedContent('in')).toEqual([])
    expect(normalizer.feedContent('k>')).toEqual([])
    expect(normalizer.feedContent('Step 1')).toEqual([{ type: 'reasoning', text: 'Step 1' }])
    expect(normalizer.feedContent('</')).toEqual([])
    expect(normalizer.feedContent('think')).toEqual([])
    expect(normalizer.feedContent('>Answer')).toEqual([{ type: 'text', text: 'Answer' }])
  })

  it('supports alternative tags: <thought>, <reasoning>, [THINK], [THINKING]', () => {
    const n1 = new StreamingThinkingNormalizer()
    expect(n1.feedContent('<thought>deep thought</thought>text output')).toEqual([
      { type: 'reasoning', text: 'deep thought' },
      { type: 'text', text: 'text output' },
    ])

    const n2 = new StreamingThinkingNormalizer()
    expect(n2.feedContent('[THINK]bracket thought[/THINK]done')).toEqual([
      { type: 'reasoning', text: 'bracket thought' },
      { type: 'text', text: 'done' },
    ])

    const n3 = new StreamingThinkingNormalizer()
    expect(n3.feedContent('<reasoning>deductive reasoning</reasoning>solution')).toEqual([
      { type: 'reasoning', text: 'deductive reasoning' },
      { type: 'text', text: 'solution' },
    ])
  })

  it('is case-insensitive for tags (<Think>, </THINK>)', () => {
    const normalizer = new StreamingThinkingNormalizer()
    expect(normalizer.feedContent('<Think>mixed case</THINK>done')).toEqual([
      { type: 'reasoning', text: 'mixed case' },
      { type: 'text', text: 'done' },
    ])
  })

  it('strips leading newlines after closing tag cleanly', () => {
    const normalizer = new StreamingThinkingNormalizer()
    const parts = normalizer.feedContent('<think>Reasoning</think>\n\nClean text')
    expect(parts).toEqual([
      { type: 'reasoning', text: 'Reasoning' },
      { type: 'text', text: 'Clean text' },
    ])
  })

  it('does not confuse regular HTML or comparison operators with thinking tags', () => {
    const normalizer = new StreamingThinkingNormalizer()
    const code = 'if (x < y && y > 10) { return <div className="card">content</div> }'
    const parts = normalizer.feedContent(code)
    const combined = parts.map(p => p.text).join('')
    expect(combined).toBe(code)
    expect(parts.every(p => p.type === 'text')).toBe(true)
  })

  it('flushes incomplete trailing buffer at stream end', () => {
    const normalizer = new StreamingThinkingNormalizer()
    normalizer.feedContent('Normal text <')
    const flushed = normalizer.flush()
    expect(flushed).toEqual([{ type: 'text', text: '<' }])
  })
})

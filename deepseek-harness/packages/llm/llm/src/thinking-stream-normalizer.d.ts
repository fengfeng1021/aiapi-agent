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
    type: 'reasoning' | 'text';
    text: string;
}
export declare const KNOWN_THINKING_TAGS: readonly ["think", "thinking", "thought", "reasoning"];
export declare class StreamingThinkingNormalizer {
    private mode;
    private buffer;
    private justClosedThinking;
    private tagNames;
    constructor(options?: {
        initialMode?: 'text' | 'reasoning';
        extraTags?: string[];
    });
    get currentMode(): 'text' | 'reasoning';
    /**
     * Directly switch mode (e.g. when wire fields indicate reasoning).
     */
    setMode(mode: 'text' | 'reasoning'): void;
    /**
     * Process an incoming text delta that may contain in-band thinking tags.
     */
    feedContent(delta: string): NormalizedChunkPart[];
    /**
     * Flush any remaining buffer at the end of the stream.
     */
    flush(): NormalizedChunkPart[];
    private matchFullTag;
    private isTagPrefix;
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
export declare function extractWireReasoningDelta(choiceOrDelta: unknown): string | undefined;
//# sourceMappingURL=thinking-stream-normalizer.d.ts.map
/**
 * Tool Calling Syntax Repairer & Defense for Open-Source and Non-Standard LLMs.
 *
 * Repairs common JSON formatting flaws emitted by smaller or distilled models:
 * 1. Markdown code block wrapping (```json ... ```).
 * 2. Single-quoted keys/strings ({'key': 'value'}).
 * 3. Trailing commas before closing brackets ({ "a": 1, }).
 * 4. Unescaped control characters / newlines inside string literals.
 * 5. Truncated or unclosed braces/brackets from token limits.
 * 6. In-band tool call tag extraction (<tool_call> ... </tool_call>).
 *
 * @module @deepseek-ai/dsh-llm/tool-call-repairer
 */
export interface ExtractedInBandToolCall {
    name: string;
    arguments: string;
}
export interface InBandToolCallExtractionResult {
    cleanText: string;
    toolCalls: ExtractedInBandToolCall[];
}
/**
 * Clean and repair malformed JSON arguments into a standard, parseable JSON string.
 */
export declare function repairJsonArguments(raw: string): string;
/**
 * Extract in-band tool call tags (e.g. <tool_call>...</tool_call>) from text.
 */
export declare function extractInBandToolCalls(content: string): InBandToolCallExtractionResult;
//# sourceMappingURL=tool-call-repairer.d.ts.map
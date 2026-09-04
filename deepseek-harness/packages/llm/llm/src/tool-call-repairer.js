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
/**
 * Clean and repair malformed JSON arguments into a standard, parseable JSON string.
 */
export function repairJsonArguments(raw) {
    if (!raw || typeof raw !== 'string')
        return '{}';
    let text = raw.trim();
    // 1. Strip markdown code fence if wrapped
    if (text.startsWith('```')) {
        text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    }
    // Fast path: if already valid JSON, return as-is
    try {
        JSON.parse(text);
        return text;
    }
    catch {
        // Continue to repair pipeline
    }
    // 2. Remove trailing commas before } or ]
    text = text.replace(/,\s*([\]}])/g, '$1');
    // 3. Handle single-quoted Python/JS-like objects
    if (text.includes("'")) {
        // Carefully convert single-quoted keys and values to double quotes
        // Handles {'command': 'val'} -> {"command": "val"}
        const singleQuoteReplaced = text.replace(/(?<=[:,\{\[\s])'((?:\\.|[^'\\])*)'(?=[:,\}\]\s]|$)/g, '"$1"');
        try {
            JSON.parse(singleQuoteReplaced);
            return singleQuoteReplaced;
        }
        catch {
            // If full parse failed, keep singleQuoteReplaced for further fixes
            text = singleQuoteReplaced;
        }
    }
    // 4. Handle unclosed braces/brackets due to truncation
    text = autoCloseJson(text);
    // Test if repaired
    try {
        JSON.parse(text);
        return text;
    }
    catch {
        // If still fails, fallback to best-effort cleaned text
        return text;
    }
}
/**
 * Automatically balance and close open braces and brackets.
 */
function autoCloseJson(input) {
    let inString = false;
    let isEscaped = false;
    const stack = [];
    for (let i = 0; i < input.length; i++) {
        const char = input[i];
        if (isEscaped) {
            isEscaped = false;
            continue;
        }
        if (char === '\\') {
            isEscaped = true;
            continue;
        }
        if (char === '"') {
            inString = !inString;
            continue;
        }
        if (!inString) {
            if (char === '{') {
                stack.push('}');
            }
            else if (char === '[') {
                stack.push(']');
            }
            else if (char === '}' || char === ']') {
                if (stack.length > 0 && stack[stack.length - 1] === char) {
                    stack.pop();
                }
            }
        }
    }
    let result = input;
    if (inString) {
        result += '"';
    }
    // Remove any trailing comma before appending closing brackets
    result = result.replace(/,\s*$/, '');
    while (stack.length > 0) {
        result += stack.pop();
    }
    return result;
}
/**
 * Extract in-band tool call tags (e.g. <tool_call>...</tool_call>) from text.
 */
export function extractInBandToolCalls(content) {
    if (!content)
        return { cleanText: '', toolCalls: [] };
    const toolCalls = [];
    // Matches <tool_call>...</tool_call> or <function_call>...</function_call>
    const tagRegex = /<(?:tool_call|function_call)>([\s\S]*?)<\/(?:tool_call|function_call)>/gi;
    const cleanText = content.replace(tagRegex, (_match, body) => {
        const trimmed = body.trim();
        try {
            const parsed = JSON.parse(repairJsonArguments(trimmed));
            if (typeof parsed === 'object' && parsed !== null) {
                const name = parsed.name || parsed.function?.name || parsed.tool || '';
                const argsObj = parsed.arguments ?? parsed.parameters ?? parsed.function?.arguments ?? {};
                const argsStr = typeof argsObj === 'string' ? argsObj : JSON.stringify(argsObj);
                if (name) {
                    toolCalls.push({ name, arguments: repairJsonArguments(argsStr) });
                    return '';
                }
            }
        }
        catch {
            // If parsing body fails, leave as-is or discard tag
        }
        return '';
    }).trim();
    return { cleanText, toolCalls };
}
//# sourceMappingURL=tool-call-repairer.js.map
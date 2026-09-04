import { describe, expect, it } from 'vitest'
import {
  repairJsonArguments,
  extractInBandToolCalls,
} from '../src/tool-call-repairer.ts'

describe('repairJsonArguments', () => {
  it('returns valid JSON as-is', () => {
    const valid = '{"command":"ls -la","timeout":1000}'
    expect(repairJsonArguments(valid)).toBe(valid)
  })

  it('strips markdown code block wrappers (```json ... ```)', () => {
    const wrapped = '```json\n{"path":"/src/index.ts","content":"hello"}\n```'
    expect(repairJsonArguments(wrapped)).toBe('{"path":"/src/index.ts","content":"hello"}')
  })

  it('removes trailing commas before closing braces/brackets', () => {
    const trailing = '{"files": ["a.txt", "b.txt",], "recursive": true,}'
    const repaired = repairJsonArguments(trailing)
    expect(JSON.parse(repaired)).toEqual({
      files: ['a.txt', 'b.txt'],
      recursive: true,
    })
  })

  it('repairs single-quoted python/JS objects', () => {
    const single = "{'command': 'git status', 'cwd': 'D:/repo'}"
    const repaired = repairJsonArguments(single)
    expect(JSON.parse(repaired)).toEqual({
      command: 'git status',
      cwd: 'D:/repo',
    })
  })

  it('auto-closes truncated JSON strings and braces', () => {
    const truncated = '{"command": "cat package.json", "options": {"encoding": "utf-8'
    const repaired = repairJsonArguments(truncated)
    expect(JSON.parse(repaired)).toEqual({
      command: 'cat package.json',
      options: { encoding: 'utf-8' },
    })
  })
})

describe('extractInBandToolCalls', () => {
  it('extracts <tool_call> tags and cleans text', () => {
    const content = 'I will run the command now.\n<tool_call>{"name": "bash", "arguments": {"command": "echo 123"}}</tool_call>\nPlease wait.'
    const result = extractInBandToolCalls(content)
    expect(result.cleanText).toBe('I will run the command now.\n\nPlease wait.')
    expect(result.toolCalls).toEqual([
      { name: 'bash', arguments: '{"command":"echo 123"}' },
    ])
  })

  it('extracts <function_call> with markdown-wrapped JSON inside', () => {
    const content = '<function_call>\n```json\n{"name": "file_write", "arguments": {"path": "test.txt"}}\n```\n</function_call>'
    const result = extractInBandToolCalls(content)
    expect(result.cleanText).toBe('')
    expect(result.toolCalls).toEqual([
      { name: 'file_write', arguments: '{"path":"test.txt"}' },
    ])
  })
})

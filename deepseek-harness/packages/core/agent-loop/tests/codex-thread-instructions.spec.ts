import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexAppServerDaemon } from '../src/codex-server.ts'

const STUB = [
  "const readline = require('node:readline')",
  "const fs = require('node:fs')",
  'const capture = process.env.STUB_CAPTURE',
  'async function main() {',
  '  const rl = readline.createInterface({ input: process.stdin })',
  "  const send = (id, result) => { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n') }",
  '  for await (const line of rl) {',
  '    let msg',
  '    try { msg = JSON.parse(line) } catch { continue }',
  '    if (msg.id === undefined) continue',
  "    if (msg.method === 'initialize') send(msg.id, { capabilities: {} })",
  "    else if (msg.method === 'thread/start') {",
  '      if (capture) fs.writeFileSync(capture, JSON.stringify(msg.params ?? null))',
  "      send(msg.id, { thread: { id: 'thread-stub' } })",
  '    } else send(msg.id, null)',
  '  }',
  '}',
  'main()',
  '',
].join('\n')

describe('CodexAppServerDaemon thread instructions', () => {
  const previousHome = process.env.CODEX_ISOLATED_HOME
  const previousCapture = process.env.STUB_CAPTURE
  let dir = ''
  let daemon: CodexAppServerDaemon

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'codex-thread-'))
    process.env.CODEX_ISOLATED_HOME = dir
    process.env.STUB_CAPTURE = join(dir, 'thread-start.json')
    writeFileSync(join(dir, 'stub-server.js'), STUB)
    daemon = new CodexAppServerDaemon(join(dir, 'stub-server.js'))
  })

  afterAll(() => {
    daemon.dispose()
    if (previousHome === undefined) delete process.env.CODEX_ISOLATED_HOME
    else process.env.CODEX_ISOLATED_HOME = previousHome
    if (previousCapture === undefined) delete process.env.STUB_CAPTURE
    else process.env.STUB_CAPTURE = previousCapture
  })

  it('forwards developer instructions on thread/start', async () => {
    const id = await daemon.createThread({ cwd: dir, developerInstructions: '請用白話文總結' })
    expect(id).toBe('thread-stub')
    const params = JSON.parse(readFileSync(join(dir, 'thread-start.json'), 'utf8')) as Record<string, unknown>
    expect(params.developer_instructions).toBe('請用白話文總結')
  })

  it('omits developer instructions when none are given', async () => {
    await daemon.createThread({ cwd: dir })
    const params = JSON.parse(readFileSync(join(dir, 'thread-start.json'), 'utf8')) as Record<string, unknown>
    expect('developer_instructions' in params).toBe(false)
  })

  it('publishes the delegate dynamic tool on thread/start', async () => {
    await daemon.createThread({ cwd: dir })
    const params = JSON.parse(readFileSync(join(dir, 'thread-start.json'), 'utf8')) as Record<string, unknown>
    // Params go out verbatim (camelCase) — verified against live traffic.
    expect(params.dynamicTools).toEqual([
      expect.objectContaining({
        type: 'function',
        name: 'delegate',
        inputSchema: expect.objectContaining({
          type: 'object',
          required: ['task'],
          additionalProperties: false,
        }),
      }),
    ])
  })
})

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CodexAppServerDaemon,
  type CodexThreadToolOwner,
  type CodexTurnHandlers,
  type CodexTurnItem,
} from '../src/codex-server.ts'
import type {
  DynamicToolCallParams,
  DynamicToolCallResponse,
} from '../src/codex-delegation.ts'

/**
 * Scripted app-server fixture for the `item/tool/call` round trip. Modes:
 * - `roundtrip`: on `turn/start`, emits a dynamic tool item, issues
 *   `item/tool/call`, captures the daemon's `/response`, then completes.
 * - `owner-throw`: same drive, but the daemon's owner rejects; captures the
 *   JSON-RPC error so the test can assert the failure text.
 * - `no-turn`: issues `item/tool/call` with no active turn right after the
 *   handshake and captures the daemon's rejection.
 */
function writeFixture(dir: string, threadId: string): string {
  const bin = join(dir, 'fake-dynamic-tool-server.js')
  writeFileSync(bin, `import readline from 'node:readline';
import fs from 'node:fs';
const capture = process.env.STUB_CAPTURE;
const mode = process.env.STUB_MODE ?? 'roundtrip';
const thread = ${JSON.stringify(threadId)};
const rl = readline.createInterface({ input: process.stdin });
const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
const toolItem = { id: 'dyn-1', type: 'dynamicToolCall', tool: 'delegate', arguments: { task: 'do X' } };
const toolCall = () => ({ threadId: thread, turnId: 't-1', callId: 'c-1', itemId: 'dyn-1', tool: 'delegate', arguments: { task: 'do X' } });
let seenTurnStart = null;
function completeTurn() {
  write({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: thread, item: { ...toolItem, success: true } } });
  write({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: thread, turn: { id: 't-1', status: 'completed', items: [] } } });
  write({ jsonrpc: '2.0', id: seenTurnStart, result: { turn: { id: 't-1' } } });
  seenTurnStart = null;
}
rl.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === 'initialize') {
    write({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } });
    if (mode === 'no-turn') {
      write({ jsonrpc: '2.0', id: 101, method: 'item/tool/call', params: toolCall() });
    }
    return;
  }
  if (message.method === 'thread/start') {
    write({ jsonrpc: '2.0', id: message.id, result: { thread: { id: 'thread-stub' } } });
    return;
  }
  if (message.method === 'turn/start') {
    seenTurnStart = message.id;
    write({ jsonrpc: '2.0', method: 'item/started', params: { threadId: thread, item: toolItem } });
    write({ jsonrpc: '2.0', id: 101, method: 'item/tool/call', params: toolCall() });
    return;
  }
  if (message.id === 101 && message.method === undefined) {
    if (capture) fs.writeFileSync(capture, JSON.stringify(message));
    if (mode === 'no-turn') return;
    completeTurn();
  }
});
`)
  return bin
}

async function waitForCapture(path: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10000
  for (;;) {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

describe('CodexAppServerDaemon item/tool/call round trip', () => {
  let dir: string | undefined
  const previousCapture = process.env.STUB_CAPTURE
  const previousMode = process.env.STUB_MODE

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
    dir = undefined
    if (previousCapture === undefined) delete process.env.STUB_CAPTURE
    else process.env.STUB_CAPTURE = previousCapture
    if (previousMode === undefined) delete process.env.STUB_MODE
    else process.env.STUB_MODE = previousMode
  })

  it('routes a dynamic tool call to the turn owner and posts its result', async () => {
    dir = mkdtempSync(join(tmpdir(), 'codex-dyn-roundtrip-'))
    const capture = join(dir, 'response.json')
    process.env.STUB_CAPTURE = capture
    process.env.STUB_MODE = 'roundtrip'
    const daemon = new CodexAppServerDaemon(writeFixture(dir, 'thread-dyn'))
    try {
      const ownerCalls: DynamicToolCallParams[] = []
      const owner: CodexThreadToolOwner = {
        executeDynamicTool: (params: DynamicToolCallParams): Promise<DynamicToolCallResponse> => {
          ownerCalls.push(params)
          return Promise.resolve({
            contentItems: [{ type: 'inputText', text: 'child answer' }],
            success: true,
          })
        },
      }
      const started: CodexTurnItem[] = []
      const completed: CodexTurnItem[] = []
      const handlers: CodexTurnHandlers = {
        onItemStarted: (item) => { started.push(item) },
        onItemCompleted: (item) => { completed.push(item) },
      }
      const result = await daemon.startTurn('thread-dyn', [], handlers, undefined, owner)
      expect(result.status).toBe('completed')
      expect(ownerCalls).toEqual([{
        threadId: 'thread-dyn',
        turnId: 't-1',
        callId: 'c-1',
        itemId: 'dyn-1',
        tool: 'delegate',
        arguments: { task: 'do X' },
      }])
      expect(started).toHaveLength(1)
      expect(started[0]).toMatchObject({ id: 'dyn-1', type: 'dynamicToolCall' })
      expect(completed).toHaveLength(1)
      expect(completed[0]).toMatchObject({ id: 'dyn-1', type: 'dynamicToolCall' })
      const reply = await waitForCapture(capture)
      // Proven against the live app-server: the direct JSON-RPC response body
      // is the owner result verbatim (no id echo, no snake_case) — the server
      // matches it to the call by request id and resumes the model.
      expect(reply.result).toEqual({
        contentItems: [{ type: 'inputText', text: 'child answer' }],
        success: true,
      })
    } finally {
      daemon.dispose()
    }
  }, 20000)

  it('rejects a dynamic tool call with no active turn', async () => {
    dir = mkdtempSync(join(tmpdir(), 'codex-dyn-noturn-'))
    const capture = join(dir, 'response.json')
    process.env.STUB_CAPTURE = capture
    process.env.STUB_MODE = 'no-turn'
    const daemon = new CodexAppServerDaemon(writeFixture(dir, 'thread-ghost'))
    try {
      // No turn ever starts on thread-ghost; the createThread only wakes the
      // lazy transport so the handshake-time tool call gets answered.
      await daemon.createThread({ cwd: dir })
      const reply = await waitForCapture(capture)
      expect(reply.error).toMatchObject({ code: -32603 })
      expect(String((reply.error as { message?: string }).message)).toContain('no active turn')
    } finally {
      daemon.dispose()
    }
  }, 20000)

  it('surfaces owner failures as request errors without breaking the turn', async () => {
    dir = mkdtempSync(join(tmpdir(), 'codex-dyn-ownerthrow-'))
    const capture = join(dir, 'response.json')
    process.env.STUB_CAPTURE = capture
    process.env.STUB_MODE = 'roundtrip'
    const daemon = new CodexAppServerDaemon(writeFixture(dir, 'thread-dyn'))
    try {
      const owner: CodexThreadToolOwner = {
        executeDynamicTool: () => Promise.reject(new Error('boom-owner')),
      }
      const result = await daemon.startTurn('thread-dyn', [], {}, undefined, owner)
      expect(result.status).toBe('completed')
      const reply = await waitForCapture(capture)
      expect(reply.error).toMatchObject({ code: -32603 })
      expect(String((reply.error as { message?: string }).message)).toContain('boom-owner')
    } finally {
      daemon.dispose()
    }
  }, 20000)
})

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JsonRpcResponseError } from '@deepseek-ai/dsh-sdk-protocol'
import { CodexAppServerDaemon, CodexThreadGoneError } from '../src/codex-server.ts'

/**
 * Scripted app-server fixture: answers the daemon handshake, then rejects
 * every `turn/start` with the scenario's wire error. Written per test into a
 * temp dir (parallel-safe) as `.js` so the daemon's wrapper detection treats
 * it like the official wrapper and spawns it under Node.
 */
function writeFakeServer(dir: string, turnStartError: { code: number; message: string }): string {
  const bin = join(dir, 'fake-codex-app-server.js')
  writeFileSync(bin, `import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
const error = ${JSON.stringify(turnStartError)};
rl.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\\n');
  } else if (message.method === 'turn/start') {
    const detail = typeof message.params?.threadId === 'string' ? message.params.threadId : '?';
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: error.code, message: error.message.replaceAll('<id>', detail) },
    }) + '\\n');
  }
});
`)
  return bin
}

async function rejectedStartTurn(bin: string): Promise<unknown> {
  const daemon = new CodexAppServerDaemon(bin)
  try {
    return await daemon.startTurn('thread-stale', [], {}).then(
      () => { throw new Error('turn/start should have rejected') },
      (error: unknown) => error,
    )
  } finally {
    daemon.dispose()
  }
}

describe('CodexAppServerDaemon turn/start wire errors', () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('maps a thread-miss rejection to CodexThreadGoneError', async () => {
    dir = mkdtempSync(join(tmpdir(), 'codex-fake-miss-'))
    const failure = await rejectedStartTurn(
      writeFakeServer(dir, { code: -32600, message: 'thread not found: <id>' }),
    )
    expect(failure).toBeInstanceOf(CodexThreadGoneError)
    expect(failure).toMatchObject({ threadId: 'thread-stale' })
    expect((failure as Error).message).toContain('thread-stale')
  }, 15000)

  it('passes through other invalid-request rejections unchanged', async () => {
    dir = mkdtempSync(join(tmpdir(), 'codex-fake-other-'))
    const failure = await rejectedStartTurn(
      writeFakeServer(dir, { code: -32600, message: 'malformed request: bad input' }),
    )
    expect(failure).not.toBeInstanceOf(CodexThreadGoneError)
    expect(failure).toBeInstanceOf(JsonRpcResponseError)
    expect((failure as Error).message).toContain('malformed request')
  }, 15000)

  it('passes through thread-miss text under a different wire code unchanged', async () => {
    dir = mkdtempSync(join(tmpdir(), 'codex-fake-code-'))
    const failure = await rejectedStartTurn(
      writeFakeServer(dir, { code: -32000, message: 'thread not found: <id>' }),
    )
    expect(failure).not.toBeInstanceOf(CodexThreadGoneError)
    expect(failure).toBeInstanceOf(JsonRpcResponseError)
  }, 15000)
})

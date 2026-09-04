#!/usr/bin/env node

import { access, mkdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

const here = dirname(fileURLToPath(import.meta.url))
const runtimeBin = resolve(here, '../node_modules/@deepseek-ai/dsh/lib/bin.js')
const bundledPnpm = resolve(here, '../node_modules/pnpm/bin/pnpm.cjs')
const args = process.argv.slice(2)
const color = output.isTTY && process.env.NO_COLOR === undefined
const paint = (code, text) => color ? `\u001b[${code}m${text}\u001b[0m` : text
const blue = text => paint('38;2;67;133;255', text)
const dim = text => paint('2', text)
const bold = text => paint('1', text)
const red = text => paint('31', text)

const LOGO = String.raw`
  ____                  ____            _
 |  _ \  ___  ___ _ __/ ___|  ___  ___| | __
 | | | |/ _ \/ _ \ '_ \___ \ / _ \/ _ \ |/ /
 | |_| |  __/  __/ |_) |__) |  __/  __/   <
 |____/ \___|\___| .__/____/ \___|\___|_|\_\
                 |_|        HARNESS CLI`

function option(name) {
  const index = args.indexOf(name)
  if (index >= 0) return args[index + 1]
  return args.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1)
}

function printHelp() {
  console.log(`${LOGO}

Usage: dsh-cli [--cwd <project>] [--provider <id>] [--model <id>]

Interactive commands:
  /help     Show commands
  /new      Start a new conversation in the same project
  /clear    Clear the terminal
  /cwd      Show the active project directory
  /exit     Close the CLI

The CLI boots the standard, extensible TUI profile bundled with DeepSeek Harness
Desktop. It shares profiles, plugins, sessions, settings, and the managed
DeepSeek credential under ~/.dsh.`)
}

if (args.includes('--help') || args.includes('-h')) {
  printHelp()
  process.exit(0)
}

async function chooseWorkspace(terminal) {
  let candidate = resolve(option('--cwd') ?? process.env.DSH_CLI_CWD ?? process.cwd())
  for (;;) {
    const answer = (await terminal.question(
      `${blue('?')} 工程文件夹 ${dim(`[${candidate}]`)}: `,
    )).trim()
    if (answer !== '') candidate = resolve(answer.replace(/^~(?=$|[\\/])/, homedir()))
    try {
      const info = await stat(candidate)
      if (info.isDirectory()) return candidate
      console.log(red('该路径不是文件夹，请重新输入。'))
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.log(red(`无法访问该路径：${error instanceof Error ? error.message : String(error)}`))
        continue
      }
      const create = (await terminal.question(`${blue('?')} 文件夹不存在，是否新建？ ${dim('[Y/n]')}: `))
        .trim().toLowerCase()
      if (create === '' || create === 'y' || create === 'yes') {
        await mkdir(candidate, { recursive: true })
        return candidate
      }
    }
  }
}

function startSpinner(label) {
  if (!output.isTTY) return () => {}
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  let index = 0
  const timer = setInterval(() => {
    output.write(`\r${blue(frames[index++ % frames.length])} ${label}`)
  }, 80)
  return () => {
    clearInterval(timer)
    output.write('\r\u001b[2K')
  }
}

async function main() {
  await Promise.all([access(runtimeBin), access(bundledPnpm)])
  const { DeepSeekHarness } = await import('@deepseek-ai/dsh-sdk-client')
  console.log(blue(LOGO))
  console.log(dim('  桌面版同源运行时 · 输入 /help 查看命令 · Ctrl+C 退出\n'))

  const terminal = createInterface({ input, output, terminal: true })
  const cwd = await chooseWorkspace(terminal)
  const dshHome = resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'))
  const provider = option('--provider') ?? process.env.DSH_CLI_PROVIDER ?? 'deepseek-official'
  const model = option('--model') ?? process.env.DSH_CLI_MODEL ?? 'deepseek-v4-flash'
  const launchEnv = {
    ...process.env,
    DSH_HOME: dshHome,
    DSH_INSTALL_ANCHOR: resolve(here, '../package.json'),
    DSH_PNPM_CLI: bundledPnpm,
  }
  const harness = new DeepSeekHarness({
    launch: {
      command: process.execPath,
      args: [runtimeBin, '--profile', 'tui'],
      cwd,
      env: launchEnv,
    },
    cwd,
    provider,
    model,
  })
  let session = harness.session()
  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    terminal.close()
    await harness.close().catch(() => undefined)
  }
  process.once('SIGINT', () => { void close() })
  process.once('SIGTERM', () => { void close() })

  console.log(`${dim('工程')} ${cwd}`)
  console.log(`${dim('模型')} ${provider}/${model}\n`)
  while (!closing) {
    let prompt
    try {
      prompt = (await terminal.question(`${blue('❯')} `)).trim()
    } catch {
      break
    }
    if (prompt === '') continue
    if (prompt === '/exit' || prompt === '/quit') break
    if (prompt === '/help') {
      console.log(dim('/new 新会话 · /clear 清屏 · /cwd 当前工程 · /exit 退出'))
      continue
    }
    if (prompt === '/clear') {
      console.clear()
      console.log(blue(LOGO))
      continue
    }
    if (prompt === '/cwd') {
      console.log(cwd)
      continue
    }
    if (prompt === '/new') {
      session = harness.session()
      console.log(dim('已开始新会话。'))
      continue
    }
    const stopSpinner = startSpinner('DeepSeek 正在思考…')
    try {
      const result = await session.run(prompt)
      stopSpinner()
      console.log(`${blue('●')} ${bold('DeepSeek')}\n${result.finalResponse || dim('本轮没有文本输出。')}\n`)
    } catch (error) {
      stopSpinner()
      console.error(red(`运行失败：${error instanceof Error ? error.message : String(error)}`))
      console.error(dim('可在桌面版“模型”设置中配置 DeepSeek API Key，然后重试。\n'))
    }
  }
  await close()
  console.log(dim('DeepSeek Harness CLI 已退出。'))
}

main().catch((error) => {
  console.error(red(`CLI 启动失败：${error instanceof Error ? error.stack ?? error.message : String(error)}`))
  process.exitCode = 1
})

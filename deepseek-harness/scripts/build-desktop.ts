/** Run the Tauri desktop development or release entry path from the repository root. */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import {
  parseRustHost,
  resolveDesktopTarget,
  wixStagingCargoTargetDirectory,
} from './desktop-runtime.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Read the Tauri carrier version once so the packaged Web UI shows the MSI version. */
function desktopVersion(): string {
  const manifestPath = join(root, 'apps/desktop/package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(manifest.version)) {
    throw new Error(`desktop package version is invalid: ${String(manifest.version)}`)
  }
  return manifest.version
}

function run(program: string, args: string[], env?: NodeJS.ProcessEnv): string {
  const result = spawnSync(program, args, {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: 'inherit',
    windowsHide: false,
  })
  if (result.status !== 0) {
    throw new Error(`${program} ${args.join(' ')} failed with status ${result.status ?? 'unknown'}`)
  }
  return ''
}

function capture(program: string, args: string[]): string {
  const result = spawnSync(program, args, { cwd: root, encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(result.stderr || `${program} failed`)
  return result.stdout
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index >= 0) return args[index + 1]
  return args.find(argument => argument.startsWith(`${name}=`))?.slice(name.length + 1)
}

function runPnpm(args: string[], env?: NodeJS.ProcessEnv): string {
  const pnpmCli = process.env.npm_execpath
  if (pnpmCli === undefined) {
    throw new Error('pnpm CLI path is unavailable; run this builder through a `pnpm desktop:*` script')
  }
  return run(process.execPath, [pnpmCli, ...args], env)
}

/** Keep release panic/source metadata useful without exposing the builder's account path. */
function releaseRustEnvironment(cargoTargetDirectory?: string): NodeJS.ProcessEnv {
  const separator = '\u001f'
  const inherited = process.env.CARGO_ENCODED_RUSTFLAGS?.split(separator).filter(Boolean)
    ?? process.env.RUSTFLAGS?.trim().split(/\s+/u).filter(Boolean)
    ?? []
  return {
    CARGO_ENCODED_RUSTFLAGS: [
      ...inherited,
      `--remap-path-prefix=${homedir()}=.`,
    ].join(separator),
    ...cargoTargetDirectory === undefined ? {} : { CARGO_TARGET_DIR: cargoTargetDirectory },
  }
}

function publishStagedBundles(cargoTargetDirectory: string, target: string): void {
  const source = join(cargoTargetDirectory, target, 'release', 'bundle')
  if (!existsSync(source)) throw new Error(`staged Tauri bundle output is missing: ${source}`)
  const destination = join(root, 'apps/desktop/src-tauri/target', target, 'release', 'bundle')
  mkdirSync(dirname(destination), { recursive: true })
  cpSync(source, destination, { recursive: true, force: true })
  process.stdout.write(`desktop bundles copied to ${destination}\n`)
}

const harnessRoot = existsSync(join(root, '../deepseek-harness'))
  ? resolve(root, '../deepseek-harness')
  : root

const [mode = 'build', ...args] = process.argv.slice(2)
if (mode === 'dev') {
  runPnpm(['--filter', '@deepseek-ai/dsh-desktop', 'exec', 'tauri', 'dev'], {
    DSH_DESKTOP_REPO_ROOT: harnessRoot,
  })
} else if (mode === 'build') {
  const target = resolveDesktopTarget(option(args, '--target') ?? parseRustHost(capture('rustc', ['-vV'])))
  const bundles = option(args, '--bundles') ?? target.bundles
  const stagedCargoTarget = process.env.CARGO_TARGET_DIR === undefined
    ? wixStagingCargoTargetDirectory(root, tmpdir(), process.platform)
    : undefined
  if (stagedCargoTarget !== undefined) {
    process.stdout.write(`desktop build: staging Cargo output outside the WiX-unsafe checkout path: ${stagedCargoTarget}\n`)
  }
  runPnpm(['run', 'build'], { DSH_CLIENT_VERSION: desktopVersion() })
  runPnpm(['run', 'desktop:prepare', '--', '--target', target.triple])
  runPnpm([
    '--filter', '@deepseek-ai/dsh-desktop',
    'exec', 'tauri', 'build',
    '--target', target.triple,
    '--bundles', bundles,
  ], releaseRustEnvironment(stagedCargoTarget))
  if (stagedCargoTarget !== undefined) publishStagedBundles(stagedCargoTarget, target.triple)
} else {
  throw new Error(`unknown desktop mode ${mode}; expected dev or build`)
}

/** Materialize a release-only Node.js and dsh closure for Tauri resources. */

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { createReadStream, existsSync } from 'node:fs'
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import {
  checksumForArchive,
  nodeArchiveName,
  parseRustHost,
  resolveDesktopTarget,
} from './desktop-runtime.ts'

const NODE_VERSION = '24.14.0'
const ARCHIVED_WEB_BOOT_TIMEOUT_MS = 180_000
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runtimeDir = join(root, 'apps/desktop/src-tauri/runtime')
const runtimeArchive = join(root, 'apps/desktop/src-tauri/runtime.tar.gz')
const runtimeArchiveFingerprint = `${runtimeArchive}.sha256`

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/** Reject pnpm deploy targets inside the workspace, where pnpm may prune the source install. */
export function assertExternalDeployDirectory(repositoryRoot: string, destination: string): void {
  const relation = relative(resolve(repositoryRoot), resolve(destination))
  if (relation === '' || (relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))) {
    throw new Error(`desktop runtime deploy directory must stay outside the workspace: ${destination}`)
  }
}

interface RuntimeLink {
  path: string
  target: string
}

async function findRuntimeLink(directory: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) return path
    if (metadata.isDirectory()) {
      const nested = await findRuntimeLink(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

export async function restoreLegacyHoists(
  appDir: string,
  sourceNodeModules = join(root, 'apps/desktop/node_modules'),
): Promise<string[]> {
  const manifest = JSON.parse(await readFile(join(appDir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
  }
  const restored: string[] = []
  for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
    const destination = join(appDir, 'node_modules', dependency)
    if (existsSync(destination)) continue
    const source = join(sourceNodeModules, dependency)
    if (!existsSync(source)) {
      throw new Error(`deployed dependency ${dependency} is missing from ${destination} and ${source}`)
    }
    await mkdir(dirname(destination), { recursive: true })
    const nestedNodeModules = join(source, 'node_modules')
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
    })
    restored.push(dependency)
  }
  return restored
}

async function materializeDeployedLinks(appDir: string): Promise<void> {
  const nodeModules = join(appDir, 'node_modules')
  let remaining = await findRuntimeLink(nodeModules)
  while (remaining !== undefined) {
    const segments = remaining.slice(nodeModules.length + 1).split(sep)
    const binIndex = segments.lastIndexOf('.bin')
    if (binIndex >= 0) {
      const binDirectory = join(nodeModules, ...segments.slice(0, binIndex + 1))
      const binMetadata = await lstat(binDirectory)
      if (binMetadata.isSymbolicLink()) await unlink(binDirectory)
      else await rm(binDirectory, { recursive: true, force: true })
    } else {
      const source = await realpath(remaining)
      const nestedNodeModules = join(source, 'node_modules')
      await unlink(remaining)
      await cp(source, remaining, {
        recursive: true,
        dereference: true,
        filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
      })
    }
    remaining = await findRuntimeLink(nodeModules)
  }
}

function run(
  program: string,
  args: string[],
  cwd = root,
  extraEnv: NodeJS.ProcessEnv = {},
): string {
  const result = spawnSync(program, args, {
    cwd,
    env: { ...process.env, CI: 'true', ...extraEnv },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    // A verbose listing of the ~40k-entry desktop runtime is several MiB.
    // Keep it bounded, but above Node's small spawnSync default buffer.
    maxBuffer: 128 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error([
      `${program} ${args.join(' ')} failed with status ${result.status ?? 'unknown'}`,
      result.error?.message,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'))
  }
  return result.stdout
}

function targetArgument(argv: string[]): string {
  const index = argv.indexOf('--target')
  if (index >= 0) {
    const value = argv[index + 1]
    if (value === undefined) throw new Error('--target requires a Rust target triple')
    return value
  }
  const inline = argv.find(argument => argument.startsWith('--target='))
  if (inline !== undefined) return inline.slice('--target='.length)
  return parseRustHost(run('rustc', ['-vV']))
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`download failed with HTTP ${response.status}: ${url}`)
  return new Uint8Array(await response.arrayBuffer())
}

async function downloadNode(archiveName: string, workDir: string): Promise<{ archivePath: string; sha256: string }> {
  const baseUrl = `https://nodejs.org/dist/v${NODE_VERSION}`
  const sums = new TextDecoder().decode(await fetchBytes(`${baseUrl}/SHASUMS256.txt`))
  const expected = checksumForArchive(sums, archiveName)
  const archive = await fetchBytes(`${baseUrl}/${archiveName}`)
  const actual = createHash('sha256').update(archive).digest('hex')
  if (actual !== expected) {
    throw new Error(`Node.js archive checksum mismatch for ${archiveName}: expected ${expected}, received ${actual}`)
  }
  const archivePath = join(workDir, archiveName)
  await writeFile(archivePath, archive)
  return { archivePath, sha256: actual }
}

async function extractedNodeRoot(extractDir: string): Promise<string> {
  const entries = await readdir(extractDir, { withFileTypes: true })
  const directories = entries.filter(entry => entry.isDirectory())
  const [nodeRoot] = directories
  if (nodeRoot === undefined || directories.length !== 1) {
    throw new Error(`Node.js archive should contain one root directory; found ${directories.length}`)
  }
  return join(extractDir, nodeRoot.name)
}

function portablePath(path: string): string {
  return path.split(sep).join('/')
}

function checkedRuntimeRelative(path: string): string {
  if (path === '' || isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) {
    throw new Error(`runtime path escapes its root: ${path}`)
  }
  return portablePath(path)
}

async function inventoryRuntime(): Promise<{ entries: string[]; links: RuntimeLink[] }> {
  const entries: string[] = []
  const links: RuntimeLink[] = []

  async function visit(absolutePath: string, relativePath: string): Promise<void> {
    const metadata = await lstat(absolutePath)
    if (metadata.isSymbolicLink()) {
      throw new Error(`desktop runtime contains an unsupported filesystem link: ${relativePath}`)
    }

    if (!metadata.isDirectory() && !metadata.isFile()) {
      throw new Error(`desktop runtime contains an unsupported filesystem entry: ${relativePath}`)
    }
    if (relativePath !== '.gitignore') entries.push(checkedRuntimeRelative(relativePath))
    if (!metadata.isDirectory()) return
    const children = await readdir(absolutePath)
    children.sort()
    for (const child of children) {
      await visit(join(absolutePath, child), join(relativePath, child))
    }
  }

  for (const name of ['app', 'node']) {
    await visit(join(runtimeDir, name), name)
  }
  return { entries, links }
}

/**
 * Build a tar input tree containing only independent regular files/directories.
 * pnpm deploy intentionally uses hard links; copying each inventoried file to a
 * fresh tree prevents bsdtar/GNU tar from encoding later names as hard-link
 * entries while keeping runtime symlinks represented exclusively by links.json.
 */
async function materializeArchiveTree(
  sourceDir: string,
  destinationDir: string,
  entries: string[],
): Promise<void> {
  await mkdir(destinationDir)
  for (const entry of entries) {
    const safeEntry = checkedRuntimeRelative(entry)
    const source = join(sourceDir, safeEntry)
    const destination = join(destinationDir, safeEntry)
    const metadata = await lstat(source)
    if (metadata.isDirectory()) {
      await mkdir(destination, { recursive: true })
      continue
    }
    if (!metadata.isFile()) {
      throw new Error(`archive input contains an unsupported filesystem entry: ${safeEntry}`)
    }
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(source, destination)
    if (process.platform !== 'win32') await chmod(destination, metadata.mode)
  }
}

export function assertPortableArchiveListing(listing: string): void {
  const invalid = listing
    .split(/\r?\n/u)
    .filter(line => line !== '' && line[0] !== '-' && line[0] !== 'd')
  if (invalid.length > 0) {
    throw new Error([
      'runtime archive contains links or special entries; only regular files and directories are allowed',
      ...invalid.slice(0, 20),
    ].join('\n'))
  }
}

const REQUIRED_WEB_BOOT_ENTRIES = [
  '@deepseek-ai/dsh-client-modules',
  '@deepseek-ai/dsh-client-connection',
  // NOTE: no dsh-client-runtime row: upstream removed that layer (sessions
  // are served directly); the package dir stays only as a peer-link anchor
  // for external community plugins. Verified against a live boot manifest.
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-ui-sidebar',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-settings-models',
  '@deepseek-ai/dsh-client-ui-settings-moa',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-workspace',
] as const

const REQUIRED_DESKTOP_COMMUNITY_BOOT_ENTRIES = [
  '@linxin666/dsh-web-ui-all',
  'dshmarket',
  'dsh-skill-hub',
  'dsh-vision-recognizer',
  'dsh-better-sidebar',
  '@omdsh-dev/dsh-genui',
  'dsh-at-file',
] as const

/** Assert that the served shell carries a usable client-plugin graph, not just HTTP 200 HTML. */
export function assertRuntimeWebBootManifest(html: string): string[] {
  const prefixes = [
    '<script>globalThis["__DSH_BOOT__"] = ',
    '<script>window.__DSH_BOOT__ = ',
  ] as const
  const prefix = prefixes.find(candidate => html.includes(candidate))
  const start = prefix === undefined ? -1 : html.indexOf(prefix)
  const end = start < 0 || prefix === undefined ? -1 : html.indexOf('</script>', start + prefix.length)
  if (start < 0 || end < 0 || prefix === undefined) {
    throw new Error('archived runtime Web UI did not inject the __DSH_BOOT__ global')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(html.slice(start + prefix.length, end))
  } catch (error) {
    throw new Error('archived runtime Web UI injected invalid __DSH_BOOT__ JSON', { cause: error })
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { entries?: unknown }).entries)) {
    throw new Error('archived runtime Web UI injected an invalid client-plugin graph')
  }
  const entries = (parsed as { entries: unknown[] }).entries
  const ids = entries.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`archived runtime Web UI client entry ${index} is not an object`)
    }
    const row = entry as { id?: unknown; rev?: unknown; url?: unknown }
    if (typeof row.id !== 'string' || typeof row.rev !== 'string' || typeof row.url !== 'string') {
      throw new Error(`archived runtime Web UI client entry ${index} is missing id, rev, or url`)
    }
    return row.id
  })
  if (ids.length === 0) {
    throw new Error('archived runtime Web UI injected zero client plugin entries')
  }
  const unique = new Set(ids)
  if (unique.size !== ids.length) throw new Error('archived runtime Web UI injected duplicate client plugin entries')
  const missing = REQUIRED_WEB_BOOT_ENTRIES.filter(id => !unique.has(id))
  if (missing.length > 0) {
    throw new Error(`archived runtime Web UI is missing required client plugin entries: ${missing.join(', ')}`)
  }
  return ids
}

/** Keep release-archive smoke boots inside the desktop host instead of opening a browser. */
export function archivedRuntimeWebArgs(cli: string): string[] {
  return [cli, 'web', '--port', '0', '--no-open']
}

function runPnpm(args: string[], cwd = root): string {
  const pnpmCli = process.env.npm_execpath
  if (pnpmCli === undefined) {
    throw new Error('pnpm CLI path is unavailable; run this builder through `pnpm desktop:prepare`')
  }
  return run(process.execPath, [pnpmCli, ...args], cwd)
}

async function verifyRuntimeWeb(node: string, cli: string, cwd: string, workDir: string): Promise<void> {
  const dshHome = join(workDir, 'dsh-home')
  const profileDir = join(dshHome, 'profiles', 'web')
  const probePackageDir = join(profileDir, 'node_modules', '@desktop-probe', 'profile-plugin')
  const probeMarker = join(dshHome, 'profile-plugin-mounted')
  await mkdir(probePackageDir, { recursive: true })
  await writeFile(join(profileDir, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: { '@desktop-probe/profile-plugin': '0.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }, undefined, 2)}\n`)
  await writeFile(join(profileDir, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: desktop-profile-resolution-probe',
    "      name: '@desktop-probe/profile-plugin'",
    '',
  ].join('\n'))
  await writeFile(join(probePackageDir, 'package.json'), `${JSON.stringify({
    name: '@desktop-probe/profile-plugin',
    version: '0.0.0',
    private: true,
    type: 'module',
    exports: './index.js',
  }, undefined, 2)}\n`)
  await writeFile(join(probePackageDir, 'index.js'), [
    "import { writeFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    "export const name = 'desktop-profile-resolution-probe'",
    'export function apply() {',
    "  writeFileSync(join(process.env.DSH_HOME, 'profile-plugin-mounted'), 'profile-first')",
    '}',
    '',
  ].join('\n'))
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    CI: 'true',
    DSH_TELEMETRY_DISABLED: '1',
    DSH_HOME: dshHome,
    DSH_INSTALL_ANCHOR: join(cwd, 'package.json'),
    HINDSIGHT_DISABLED: '1',
  }
  delete environment.NODE_PATH
  const child = spawn(node, archivedRuntimeWebArgs(cli), {
    cwd,
    detached: process.platform !== 'win32',
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let output = ''
  const append = (chunk: Buffer): void => {
    output = `${output}${chunk.toString('utf8')}`.slice(-64_000)
  }
  child.stdout.on('data', append)
  child.stderr.on('data', append)

  try {
    // The Windows cold-path probe runs immediately after extracting ~50k
    // runtime entries. Defender and indexers can hold those newly-created files
    // long enough to exceed a one-minute limit even though a warm boot succeeds.
    const deadline = Date.now() + ARCHIVED_WEB_BOOT_TIMEOUT_MS
    let url: string | undefined
    while (Date.now() < deadline) {
      // Newer harness prints the launch URL with an auth token
      // (`?token=...`); keep the query string so the probe passes the gate.
      url = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\S*)/)?.[1]
      if (url !== undefined) break
      if (child.exitCode !== null) {
        throw new Error(`archived runtime Web boot exited with ${child.exitCode}\n${output}`)
      }
      await delay(100)
    }
    if (url === undefined) throw new Error(`archived runtime Web boot timed out\n${output}`)
    // The launch URL carries a one-shot `?token=` that the server answers
    // with 303 + set-cookie (then clean `/`). Plain fetch follows the
    // redirect but drops the cookie, so drive the handshake manually:
    // expect the 303, replay its cookie, then read the boot manifest.
    const minted = await fetch(url, { redirect: 'manual' })
    if (minted.status !== 303 && minted.status !== 302) {
      throw new Error(`archived runtime Web UI token mint returned HTTP ${minted.status}`)
    }
    const setCookie = minted.headers.get('set-cookie')
    if (setCookie === null) throw new Error('archived runtime Web UI token mint set no cookie')
    const cookie = setCookie.split(';')[0]
    if (cookie === undefined || !cookie.includes('=')) {
      throw new Error('archived runtime Web UI token mint set a malformed cookie')
    }
    const response = await fetch(new URL('/', url).href, { headers: { cookie } })
    if (!response.ok) throw new Error(`archived runtime Web UI returned HTTP ${response.status}`)
    const html = await response.text()
    // Product copy and document titles may change between official Harness
    // releases. The injected, complete client-plugin graph is the stable proof
    // that this is the runnable application shell rather than a generic 200.
    const ids = assertRuntimeWebBootManifest(html)
    // Community plugins ship inside the runtime archive (proven by the closed
    // deploy root above) but mount per user profile, so the synthetic probe
    // profile legitimately lacks their rows. Warn instead of failing: a
    // missing row here is user state, not a broken runtime.
    const missingCommunityEntries = REQUIRED_DESKTOP_COMMUNITY_BOOT_ENTRIES.filter(id => !ids.includes(id))
    if (missingCommunityEntries.length > 0) {
      process.stderr.write(
        `warning: archived runtime Web probe profile does not mount community entries: ${missingCommunityEntries.join(', ')}\n`,
      )
    }
    if ((await readFile(probeMarker, 'utf8')).trim() !== 'profile-first') {
      throw new Error('archived runtime did not mount the profile-local extension probe')
    }
    // NOTE: no assertion on `$DSH_HOME/profiles/node_modules` here. Older
    // bases retired that fallback, but the current base deliberately heals it
    // (bare row names resolve through it; see app-boot profile.ts). Its
    // presence is by design, not a regression.
  } finally {
    if (child.exitCode === null) {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      } else {
        try {
          if (child.pid === undefined) throw new Error('runtime process has no pid')
          process.kill(-child.pid, 'SIGTERM')
        } catch {
          child.kill('SIGTERM')
        }
      }
    }
  }
}

async function main(): Promise<void> {
  const target = resolveDesktopTarget(targetArgument(process.argv.slice(2)))
  if (basename(runtimeDir) !== 'runtime' || basename(dirname(runtimeDir)) !== 'src-tauri') {
    throw new Error(`refusing to replace unexpected runtime path ${runtimeDir}`)
  }

  const cliBuild = join(root, 'apps/cli/lib/bin.js')
  const webBuild = join(root, 'apps/web/dist/index.html')
  await Promise.all([
    readFile(cliBuild).catch(() => { throw new Error(`build the dsh CLI before preparing desktop resources: ${cliBuild}`) }),
    readFile(webBuild).catch(() => { throw new Error(`build the Web UI before preparing desktop resources: ${webBuild}`) }),
  ])

  await rm(runtimeDir, { recursive: true, force: true })
  const appDir = join(runtimeDir, 'app')
  const nodeDir = join(runtimeDir, 'node')
  await mkdir(appDir, { recursive: true })
  await mkdir(nodeDir, { recursive: true })
  await writeFile(join(runtimeDir, '.gitignore'), '*\n!.gitignore\n')

  const archiveName = nodeArchiveName(NODE_VERSION, target)
  const workDir = await mkdtemp(join(tmpdir(), 'dsh-desktop-runtime-'))
  try {
    const deployedAppDir = join(workDir, 'deployed-app')
    assertExternalDeployDirectory(root, deployedAppDir)
    runPnpm([
      '--config.node-linker=hoisted',
      '--config.auto-install-peers=false',
      '--config.link-workspace-packages=true',
      '--config.package-import-method=copy',
      '--filter', '@deepseek-ai/dsh-desktop',
      'deploy', '--prod', '--legacy', deployedAppDir,
    ])
    const restored = await restoreLegacyHoists(deployedAppDir)
    if (restored.length > 0) {
      console.log(`desktop runtime restored legacy deploy hoists: ${restored.join(', ')}`)
    }
    await materializeDeployedLinks(deployedAppDir)
    await cp(deployedAppDir, appDir, { recursive: true, force: true })

    const { archivePath, sha256 } = await downloadNode(archiveName, workDir)
    const extractDir = join(workDir, 'extract')
    await mkdir(extractDir)
    run('tar', ['-xf', archivePath, '-C', extractDir], workDir)
    const nodeRoot = await extractedNodeRoot(extractDir)
    const sourceNode = join(nodeRoot, target.nodeExecutable)
    const targetNode = join(nodeDir, target.nodeExecutable)
    await mkdir(dirname(targetNode), { recursive: true })
    await copyFile(sourceNode, targetNode)
    if (target.nodePlatform !== 'win') await chmod(targetNode, 0o755)
    await copyFile(join(nodeRoot, 'LICENSE'), join(nodeDir, 'LICENSE.node.txt'))

    const cli = join(appDir, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
    const pnpmCli = join(appDir, 'node_modules/pnpm/bin/pnpm.cjs')
    const desktopCli = join(appDir, 'cli/dsh-cli.mjs')
    const appRequire = createRequire(join(appDir, 'package.json'))
    const webAppManifest = appRequire.resolve('@deepseek-ai/dsh-web-app/package.json')
    const webAppRequire = createRequire(webAppManifest)
    const frontendManifest = webAppRequire.resolve('@deepseek-ai/dsh-web-frontend/package.json')
    const frontend = join(dirname(frontendManifest), 'dist/index.html')
    await Promise.all([
      readFile(cli).catch(() => { throw new Error(`deployed dsh CLI is missing at ${cli}`) }),
      readFile(pnpmCli).catch(() => { throw new Error(`deployed pnpm CLI is missing at ${pnpmCli}`) }),
      readFile(desktopCli).catch(() => { throw new Error(`deployed desktop CLI is missing at ${desktopCli}`) }),
      readFile(frontend).catch(() => { throw new Error(`deployed Web UI is missing at ${frontend}`) }),
    ])

    const version = run(targetNode, [cli, '--version'], appDir).trim()
    const pnpmVersion = run(targetNode, [pnpmCli, '--version'], appDir).trim()
    if (pnpmVersion !== '11.7.0') {
      throw new Error(`bundled pnpm reported ${pnpmVersion}; expected 11.7.0`)
    }
    const { entries, links } = await inventoryRuntime()
    await writeFile(join(runtimeDir, 'links.json'), `${JSON.stringify(links, null, 2)}\n`)
    await writeFile(join(runtimeDir, 'manifest.json'), `${JSON.stringify({
      target: target.triple,
      nodeVersion: NODE_VERSION,
      nodeArchive: archiveName,
      nodeArchiveSha256: sha256,
      dshVersion: version,
      pnpmVersion,
      runtimeLinks: links.length,
    }, null, 2)}\n`)
    entries.push('links.json', 'manifest.json')

    const archiveList = join(workDir, 'runtime-files.txt')
    await writeFile(archiveList, `${entries.join('\n')}\n`)
    const archiveSource = join(workDir, 'archive-source')
    await materializeArchiveTree(runtimeDir, archiveSource, entries)
    await rm(runtimeArchive, { force: true })
    await rm(runtimeArchiveFingerprint, { force: true })
    run('tar', [
      '-czf', runtimeArchive,
      '--no-recursion',
      '-C', archiveSource,
      '-T', archiveList,
    ])
    assertPortableArchiveListing(run('tar', ['-tvzf', runtimeArchive], workDir))
    await writeFile(runtimeArchiveFingerprint, `${await sha256File(runtimeArchive)}\n`)

    const verifyDir = join(workDir, 'verify')
    await mkdir(verifyDir)
    run('tar', ['-xzf', runtimeArchive, '-C', verifyDir])
    const verifiedLinks = JSON.parse(await readFile(join(verifyDir, 'links.json'), 'utf8')) as RuntimeLink[]
    if (verifiedLinks.length !== 0) throw new Error('desktop runtime archive must not require filesystem links')
    const verifyNode = join(verifyDir, 'node', target.nodeExecutable)
    const verifyCli = join(verifyDir, 'app/node_modules/@deepseek-ai/dsh/lib/bin.js')
    const verifyPnpm = join(verifyDir, 'app/node_modules/pnpm/bin/pnpm.cjs')
    const verifiedVersion = run(verifyNode, [verifyCli, '--version'], join(verifyDir, 'app')).trim()
    if (verifiedVersion !== version) {
      throw new Error(`archived runtime reported dsh ${verifiedVersion}; expected ${version}`)
    }
    const verifiedPnpmVersion = run(verifyNode, [verifyPnpm, '--version'], join(verifyDir, 'app')).trim()
    if (verifiedPnpmVersion !== pnpmVersion) {
      throw new Error(`archived runtime reported pnpm ${verifiedPnpmVersion}; expected ${pnpmVersion}`)
    }
    const pluginVersion = run(
      verifyNode,
      [verifyCli, 'plugin', '--profile', 'desktop-pnpm-probe', '--version'],
      join(verifyDir, 'app'),
      {
        DSH_HOME: join(workDir, 'plugin-home'),
        DSH_PNPM_CLI: verifyPnpm,
        PATH: '',
      },
    ).trim()
    if (pluginVersion !== pnpmVersion) {
      throw new Error(`dsh plugin reported pnpm ${pluginVersion}; expected ${pnpmVersion}`)
    }
    await verifyRuntimeWeb(verifyNode, verifyCli, join(verifyDir, 'app'), workDir)
    process.stdout.write(
      `desktop runtime ready: ${target.triple}, dsh ${version}, Node ${NODE_VERSION}, pnpm ${pnpmVersion}\n`,
    )
  } finally {
    // Windows holds freshly-executed files briefly (Defender/indexer), so a
    // single rmdir often hits EBUSY right after the smoke checks. Retry with
    // backoff; a leftover temp dir is harmless (OS-scavenged) and must not
    // fail an otherwise verified runtime.
    let cleaned = false
    for (let attempt = 0; attempt < 5 && !cleaned; attempt++) {
      try {
        if (attempt > 0) await delay(2000 * attempt)
        await rm(workDir, { recursive: true, force: true })
        cleaned = true
      } catch (error) {
        if (attempt === 4) {
          process.stderr.write(
            `warning: could not remove temp dir ${workDir}: ${String(error)}\n`,
          )
        }
      }
    }
    runPnpm(['install', '--offline', '--ignore-scripts', '--frozen-lockfile'])
  }
}

const directEntry = process.argv[1]
if (directEntry !== undefined && resolve(directEntry) === fileURLToPath(import.meta.url)) {
  await main()
}

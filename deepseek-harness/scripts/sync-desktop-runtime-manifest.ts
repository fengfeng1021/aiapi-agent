/**
 * Keep the desktop deploy root flat and complete for pnpm's legacy deploy.
 *
 * Workspace packages remain links when the repository is installed. The
 * legacy deploy implementation only materializes workspace packages declared
 * directly by the deploy root, so the desktop carrier records the full
 * transitive workspace closure as direct production dependencies.
 */
import { globSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

interface PackageManifest {
  name?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

interface DesktopManifest extends PackageManifest {
  [key: string]: unknown
}

const root = resolve(import.meta.dirname, '..')
const desktopManifestPath = resolve(root, 'apps/desktop/package.json')
const write = process.argv.slice(2).includes('--write')
const workspace = await loadWorkspacePackages()
const runtimeEntries = [
  '@deepseek-ai/dsh',
  '@deepseek-ai/dsh-sdk-client',
] as const
const externalRuntimeDependencies = {
  '@linxin666/dsh-web-ui-all': '0.2.7',
  '@omdsh-dev/dsh-genui': 'github:omdsh-dev/dsh-genui#c75ca7cec500f7804fdf8be2d43bb970691a89c3',
  '@vectorize-io/hindsight-coding-agents': '0.4.1',
  'dsh-at-file': '0.6.3',
  'dsh-better-sidebar': '0.14.0',
  'dsh-skill-hub': '0.2.5',
  'dsh-vision-recognizer': '0.2.0',
  dshmarket: '1.17.1',
  pnpm: '11.7.0',
} as const
const closure = new Set(runtimeEntries.flatMap(entry => [...collectWorkspaceClosure(entry, workspace)]))
const dependencies = Object.fromEntries(
  [
    ...[...closure].map(name => [name, 'workspace:^'] as const),
    ...Object.entries(externalRuntimeDependencies),
  ].sort(([left], [right]) => left.localeCompare(right)),
)
const desktopManifest = JSON.parse(
  await readFile(desktopManifestPath, 'utf8'),
) as DesktopManifest
const current = desktopManifest.dependencies ?? {}

if (JSON.stringify(current) === JSON.stringify(dependencies)) {
  console.log(`desktop runtime manifest: ${closure.size} workspace packages form a closed deploy root.`)
  process.exit(0)
}

if (!write) {
  const missing = Object.keys(dependencies).filter(name => current[name] === undefined)
  const stale = Object.keys(current).filter(name => dependencies[name] === undefined)
  console.error('desktop runtime manifest is stale; run: node scripts/sync-desktop-runtime-manifest.ts --write')
  if (missing.length > 0) console.error(`  missing: ${missing.join(', ')}`)
  if (stale.length > 0) console.error(`  stale: ${stale.join(', ')}`)
  process.exit(1)
}

desktopManifest.dependencies = dependencies
await writeFile(desktopManifestPath, `${JSON.stringify(desktopManifest, null, 2)}\n`)
console.log(`desktop runtime manifest updated with ${closure.size} workspace packages.`)

async function loadWorkspacePackages(): Promise<Map<string, PackageManifest>> {
  const paths = globSync([
    'apps/*/package.json',
    'native/landlock-run/package.json',
    'native/landlock-run/packages/*/package.json',
    'packages/*/*/package.json',
    'vendor/*/package.json',
  ], { cwd: root }).sort()
  const result = new Map<string, PackageManifest>()
  for (const relativePath of paths) {
    const manifest = JSON.parse(
      await readFile(resolve(root, relativePath), 'utf8'),
    ) as PackageManifest
    if (manifest.name !== undefined) result.set(manifest.name, manifest)
  }
  return result
}

function collectWorkspaceClosure(
  entry: string,
  workspace: ReadonlyMap<string, PackageManifest>,
): Set<string> {
  if (!workspace.has(entry)) throw new Error(`desktop runtime entry package is missing: ${entry}`)
  const visited = new Set<string>()
  const queue = [entry]
  for (let index = 0; index < queue.length; index += 1) {
    const name = queue[index]
    if (name === undefined || visited.has(name)) continue
    const manifest = workspace.get(name)
    if (manifest === undefined) continue
    visited.add(name)

    const next = {
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    }
    for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
      if (manifest.peerDependenciesMeta?.[peer]?.optional !== true) next[peer] = 'workspace:^'
    }
    for (const dependency of Object.keys(next).sort()) {
      if (workspace.has(dependency) && !visited.has(dependency)) queue.push(dependency)
    }
  }
  return visited
}

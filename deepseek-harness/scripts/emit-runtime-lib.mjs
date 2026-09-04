/**
 * Emit `packages/client/runtime/lib` ahead of the workspace tsdown pass.
 *
 * Background: upstream deleted the client-runtime layer (sessions are served
 * directly now), so its sources were never ported to the current APIs and the
 * package is deliberately outside the tsc aggregates. The directory must
 * still exist with a satisfying version for external plugins' peer ranges,
 * and tsdown enumerates every workspace package, so its `lib/types` entries
 * have to exist or the whole build fails with UNRESOLVED_ENTRY.
 *
 * This script type-strips the package without project references (plain tsc
 * emit; type errors are expected and ignored) purely so tsdown has entries
 * to bundle. The emitted bundle is loaded by nothing: the web boot manifest
 * no longer requires the runtime row (verified against a live boot), and no
 * source in the repo imports it. If the runtime layer is ever revived, delete
 * this script and re-add the package to tsconfig.client.json instead.
 *
 * Runs automatically as `prebuild` before `pnpm run build`, locally and on CI.
 * Skips fast when the emitted entries are newer than every source file.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkgDir = join(root, 'packages', 'client', 'runtime')
const entries = [
  join(pkgDir, 'lib', 'types', 'index.js'),
  join(pkgDir, 'lib', 'types', 'invariant.js'),
]

function newestMtime(dir) {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    if (entry.name === 'tsconfig.emit.tmp.json') continue
    try {
      newest = Math.max(newest, statSync(join(entry.parentPath, entry.name)).mtimeMs)
    } catch {}
  }
  return newest
}

function entriesFresh() {
  let oldestEntry = Infinity
  for (const entry of entries) {
    try {
      oldestEntry = Math.min(oldestEntry, statSync(entry).mtimeMs)
    } catch {
      return false
    }
  }
  return oldestEntry > newestMtime(join(pkgDir, 'src'))
}

if (entriesFresh()) {
  console.log('emit-runtime-lib: lib entries up to date, skipping')
  process.exit(0)
}

// Temp config lives beside the package so every relative path (extends,
// typeRoots, workspace `paths`) resolves exactly as a normal build. Removed
// in `finally` so no gate ever sees it.
const tmpConfig = join(pkgDir, 'tsconfig.emit.tmp.json')
try {
  writeFileSync(
    tmpConfig,
    JSON.stringify(
      {
        extends: '../../../tsconfig.base.client.json',
        compilerOptions: {
          rootDir: 'src',
          outDir: 'lib/types',
          composite: false,
          incremental: false,
          declaration: true,
          declarationMap: true,
          sourceMap: true,
          noEmit: false,
        },
        include: ['src'],
      },
      null,
      2,
    ),
  )
  try {
    execFileSync(
      process.execPath,
      [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', tmpConfig, '--pretty', 'false'],
      { cwd: root, stdio: 'pipe' },
    )
  } catch (error) {
    // Expected: superseded sources carry drift errors. Emit proceeds anyway
    // (noEmitOnError defaults to false); entries below are the real gate.
    const stderr = error?.stderr?.toString('utf8') ?? ''
    const count = (stderr.match(/error TS/g) ?? []).length
    console.log(`emit-runtime-lib: tsc reported ${count} type error(s), continuing to entry check`)
  }
  const missing = entries.filter(entry => !existsSync(entry))
  if (missing.length > 0) {
    throw new Error(`emit-runtime-lib: missing entries after emit: ${missing.join(', ')}`)
  }
  console.log('emit-runtime-lib: entries ready')
} finally {
  rmSync(tmpConfig, { force: true })
}

import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { composeEntries, loadProfile } from '@deepseek-ai/dsh-app-boot'
import {
  checksumForArchive,
  nodeArchiveName,
  parseRustHost,
  resolveDesktopTarget,
  wixStagingCargoTargetDirectory,
} from './desktop-runtime.ts'
import {
  archivedRuntimeWebArgs,
  assertExternalDeployDirectory,
  assertPortableArchiveListing,
  assertRuntimeWebBootManifest,
  restoreLegacyHoists,
  sha256File,
} from './prepare-desktop-runtime.ts'

describe('desktop runtime targets', () => {
  it('maps every shipped operating system to its official Node archive', () => {
    expect(nodeArchiveName('24.14.0', resolveDesktopTarget('x86_64-pc-windows-msvc')))
      .toBe('node-v24.14.0-win-x64.zip')
    expect(nodeArchiveName('24.14.0', resolveDesktopTarget('aarch64-apple-darwin')))
      .toBe('node-v24.14.0-darwin-arm64.tar.gz')
    expect(nodeArchiveName('24.14.0', resolveDesktopTarget('x86_64-unknown-linux-gnu')))
      .toBe('node-v24.14.0-linux-x64.tar.gz')
  })

  it('uses native installer formats instead of treating MSI as cross-platform', () => {
    expect(resolveDesktopTarget('x86_64-pc-windows-msvc').bundles).toBe('msi')
    expect(resolveDesktopTarget('aarch64-pc-windows-msvc').bundles).toBe('msi')
    expect(resolveDesktopTarget('x86_64-apple-darwin').bundles).toBe('dmg')
    expect(resolveDesktopTarget('aarch64-apple-darwin').bundles).toBe('dmg')
    expect(resolveDesktopTarget('x86_64-unknown-linux-gnu').bundles).toBe('deb,appimage')
    expect(resolveDesktopTarget('aarch64-unknown-linux-gnu').bundles).toBe('deb,appimage')
  })

  it('rejects unreviewed target triples', () => {
    expect(() => resolveDesktopTarget('i686-pc-windows-msvc')).toThrow('unsupported desktop target')
  })

  it('reads the exact Rust host and Node checksum', () => {
    expect(parseRustHost('rustc 1.97.1\nhost: x86_64-pc-windows-msvc\nrelease: 1.97.1\n'))
      .toBe('x86_64-pc-windows-msvc')
    expect(checksumForArchive(
      `${'a'.repeat(64)}  node-v24.14.0-win-x64.zip\n${'b'.repeat(64)}  other.zip\n`,
      'node-v24.14.0-win-x64.zip',
    )).toBe('a'.repeat(64))
  })

  it('stages Windows Cargo output when the checkout path would break WiX XML', () => {
    const staged = wixStagingCargoTargetDirectory(
      'C:\\work\\deepseek_gui_&_android',
      'C:\\safe-temp',
      'win32',
    )
    expect(staged).toMatch(/^C:\\safe-temp\\dsh-desktop-target-[a-f0-9]{12}$/u)
    expect(wixStagingCargoTargetDirectory('C:\\work\\deepseek-gui', 'C:\\safe-temp', 'win32'))
      .toBeUndefined()
    expect(wixStagingCargoTargetDirectory('/work/deepseek_&_android', '/tmp', 'linux'))
      .toBeUndefined()
  })
})

describe('desktop runtime archive', () => {
  it('enables the macOS private API required by the transparent pet window', () => {
    const configPath = fileURLToPath(new URL('../apps/desktop/src-tauri/tauri.conf.json', import.meta.url))
    const cargoPath = fileURLToPath(new URL('../apps/desktop/src-tauri/Cargo.toml', import.meta.url))
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      app?: { macOSPrivateApi?: boolean }
    }

    expect(config.app?.macOSPrivateApi).toBe(true)
    expect(readFileSync(cargoPath, 'utf8')).toContain('features = ["macos-private-api"]')
  })

  it('bundles a sidecar fingerprint so same-version runtime changes invalidate the cache', async () => {
    const configPath = fileURLToPath(new URL('../apps/desktop/src-tauri/tauri.conf.json', import.meta.url))
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      bundle?: { resources?: string[] }
    }
    expect(config.bundle?.resources).toContain('runtime.tar.gz.sha256')

    expect(await sha256File(configPath)).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('keeps pnpm deploy staging outside the source workspace', () => {
    expect(() => assertExternalDeployDirectory('C:\\work\\dsh', 'C:\\temp\\dsh-runtime')).not.toThrow()
    expect(() => assertExternalDeployDirectory('C:\\work\\dsh', 'C:\\work\\dsh\\apps\\desktop\\runtime'))
      .toThrow(/outside the workspace/u)
  })

  it('restores legacy deploy hoists without packing unresolved workspace ranges', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'dsh-desktop-legacy-hoist-'))
    const appDir = join(fixture, 'deployed-app')
    const sourceNodeModules = join(fixture, 'source-node-modules')
    const source = join(sourceNodeModules, '@fixture', 'workspace-package')
    mkdirSync(join(source, 'lib'), { recursive: true })
    mkdirSync(join(source, 'node_modules', '@fixture', 'uninstalled-workspace-peer'), { recursive: true })
    mkdirSync(appDir, { recursive: true })
    writeFileSync(join(appDir, 'package.json'), JSON.stringify({
      dependencies: { '@fixture/workspace-package': 'workspace:^' },
    }))
    writeFileSync(join(source, 'package.json'), JSON.stringify({
      name: '@fixture/workspace-package',
      version: '1.0.0',
      dependencies: { '@fixture/uninstalled-workspace-peer': 'workspace:^' },
    }))
    writeFileSync(join(source, 'lib', 'index.js'), 'export const restored = true\n')
    writeFileSync(join(source, 'node_modules', '@fixture', 'uninstalled-workspace-peer', 'index.js'), 'excluded\n')

    await expect(restoreLegacyHoists(appDir, sourceNodeModules))
      .resolves.toEqual(['@fixture/workspace-package'])
    expect(readFileSync(join(appDir, 'node_modules', '@fixture', 'workspace-package', 'lib', 'index.js'), 'utf8'))
      .toBe('export const restored = true\n')
    expect(existsSync(join(
      appDir,
      'node_modules',
      '@fixture',
      'workspace-package',
      'node_modules',
    ))).toBe(false)
  })

  it('never opens the system browser during archived-runtime smoke tests', () => {
    expect(archivedRuntimeWebArgs('dsh.js'))
      .toEqual(['dsh.js', 'web', '--port', '0', '--no-open'])
  })

  it('accepts only regular files and directories in the final tar listing', () => {
    expect(() => {
      assertPortableArchiveListing([
        'drwxr-xr-x  0 0      0           0 Jan 01 00:00 app/',
        '-rw-r--r--  0 0      0         128 Jan 01 00:00 app/index.js',
      ].join('\n'))
    }).not.toThrow()
    expect(() => {
      assertPortableArchiveListing(
        'hrw-r--r--  0 0      0           0 Jan 01 00:00 app/duplicate link to app/index.js',
      )
    }).toThrow(/links or special entries/u)
    expect(() => {
      assertPortableArchiveListing(
        'lrwxr-xr-x  0 0      0           0 Jan 01 00:00 app/link -> target',
      )
    }).toThrow(/links or special entries/u)
  })

  it('rejects an HTTP-success shell whose client plugin graph is empty', () => {
    expect(() => assertRuntimeWebBootManifest(
      '<html><head><script>globalThis["__DSH_BOOT__"] = {"rev":"empty","entries":[]}</script></head></html>',
    )).toThrow(/zero client plugin entries/u)
  })

  it('accepts a branding-independent shell with a complete junction-free client plugin graph', () => {
    const ids = [
      '@deepseek-ai/dsh-client-modules',
      '@deepseek-ai/dsh-client-connection',
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-ui-layout',
      '@deepseek-ai/dsh-client-ui-sidebar',
      '@deepseek-ai/dsh-client-ui-settings',
      '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-ui-workspace',
    ]
    const graph = { rev: 'fixture', entries: ids.map(id => ({ id, rev: '1', url: `/plugins/${id}/client.js` })) }
    const html = `<html><head><title>DSH Local Build</title><script>globalThis["__DSH_BOOT__"] = ${JSON.stringify(graph)}</script></head></html>`
    expect(assertRuntimeWebBootManifest(html)).toEqual(ids)
  })

  it('still accepts the legacy window boot-global form from older bundled runtimes', () => {
    const ids = [
      '@deepseek-ai/dsh-client-modules',
      '@deepseek-ai/dsh-client-connection',
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-ui-layout',
      '@deepseek-ai/dsh-client-ui-sidebar',
      '@deepseek-ai/dsh-client-ui-settings',
      '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-ui-workspace',
    ]
    const graph = { rev: 'legacy', entries: ids.map(id => ({ id, rev: '1', url: `/plugins/${id}/client.js` })) }
    const html = `<script>window.__DSH_BOOT__ = ${JSON.stringify(graph)}</script>`
    expect(assertRuntimeWebBootManifest(html)).toEqual(ids)
  })
})

describe('desktop startup progress', () => {
  it('uses a CSP-safe native value instead of a blocked inline width', () => {
    const html = readFileSync(
      fileURLToPath(new URL('../apps/desktop/frontend/index.html', import.meta.url)),
      'utf8',
    )
    const script = readFileSync(
      fileURLToPath(new URL('../apps/desktop/frontend/app.js', import.meta.url)),
      'utf8',
    )
    const styles = readFileSync(
      fileURLToPath(new URL('../apps/desktop/frontend/styles.css', import.meta.url)),
      'utf8',
    )

    expect(html).toMatch(/<progress[\s\S]*?value="1"[\s\S]*?max="100"/u)
    expect(html).not.toMatch(/\sstyle=/u)
    expect(script).toContain('progress.value = bounded')
    expect(script).not.toContain('.style.width')
    expect(styles).toContain('.progress::-webkit-progress-value')
    expect(html).toContain('首次设置 · 仅显示一次')
    expect(html).toContain('href="dsh-action://retry"')
    expect(html).toContain('id="retry-startup"')
    expect(html).toContain('id="copy-diagnostics"')
    expect(script).toContain('if (retryPending)')
    expect(script).toContain('navigator.clipboard.writeText(diagnosticText)')
  })
})

describe('desktop CLI runtime', () => {
  it('keeps dynamically selected directory-picker packages resolvable from the CLI install anchor', () => {
    const manifestPath = fileURLToPath(new URL('../apps/cli/package.json', import.meta.url))
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dependencies?: Record<string, string>
    }
    for (const name of [
      '@deepseek-ai/dsh-client-ui-directory-picker-browse',
      '@deepseek-ai/dsh-client-ui-directory-picker-native',
      '@deepseek-ai/dsh-host-directory-picker-browse',
      '@deepseek-ai/dsh-host-directory-picker-native',
    ]) {
      expect(manifest.dependencies?.[name], name).toBe('workspace:^')
    }
  })

  it('boots the standard extensible TUI profile instead of a fixed plugin tree', () => {
    const configPath = fileURLToPath(new URL('../packages/bundle/tui/cordis.patch.yml', import.meta.url))
    const entries: unknown = yaml.load(readFileSync(configPath, 'utf8'), { schema: entryListSchema })
    if (!Array.isArray(entries)) throw new TypeError('TUI bundle patch must parse to an entry array')
    const patches = entries as PatchOptions[]
    const byId = new Map(patches.map(row => [row.id, row]))
    const inserted = patches.flatMap(row => row.insert ?? [])
    expect(inserted).toContainEqual(expect.objectContaining({
      id: 'sdk-jsonrpc-server',
      name: '@deepseek-ai/dsh-sdk-jsonrpc-server',
    }))
    expect([...byId.keys()].filter(Boolean)).toEqual(['system-prompt', 'tools'])

    const launcherPath = fileURLToPath(new URL('../apps/desktop/cli/dsh-cli.mjs', import.meta.url))
    const launcher = readFileSync(launcherPath, 'utf8')
    expect(launcher).toContain('@deepseek-ai/dsh/lib/bin.js')
    expect(launcher).toContain('args: [runtimeBin, \'--profile\', \'tui\']')
    expect(launcher).toContain("DSH_INSTALL_ANCHOR: resolve(here, '../package.json')")
    expect(launcher).not.toContain('dsh-sdk-jsonrpc-demo')
    expect(launcher).not.toContain('DSH_CORDIS_CONFIG')
  })

  it('pins the plugin manager carried inside the independent runtime', () => {
    const manifestPath = fileURLToPath(new URL('../apps/desktop/package.json', import.meta.url))
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(manifest.dependencies?.pnpm).toBe('11.7.0')
  })

  it('composes the plugin market and skills hub rows into the shipped Web profile', () => {
    const manifestPath = fileURLToPath(new URL('../apps/desktop/package.json', import.meta.url))
    const profile = loadProfile(
      'dsh',
      'web',
      manifestPath,
      mkdtempSync(join(tmpdir(), 'dsh-desktop-web-profile-')),
    )
    const rows = composeEntries([profile.layers.flatMap(layer => layer.patches)])
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'dsh-market', name: 'dshmarket' }),
      expect.objectContaining({ id: 'skill-hub', name: 'dsh-skill-hub' }),
    ]))
  })

  it('pins and activates the eight reviewed community bundles in desktop order', () => {
    const manifestPath = fileURLToPath(new URL('../apps/desktop/package.json', import.meta.url))
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { installationProfiles?: Record<string, { bundles?: string[] }> }
    }
    const bundles = [
      '@linxin666/dsh-web-ui-all',
      'dshmarket',
      'dsh-skill-hub',
      '@vectorize-io/hindsight-coding-agents',
      'dsh-vision-recognizer',
      'dsh-better-sidebar',
      '@omdsh-dev/dsh-genui',
      'dsh-at-file',
    ]
    expect(manifest.dsh?.installationProfiles?.web?.bundles).toEqual(bundles)
    for (const bundle of bundles) {
      expect(manifest.dependencies?.[bundle], bundle).toBeDefined()
    }
    expect(manifest.dependencies?.['@omdsh-dev/dsh-genui'])
      .toBe('github:omdsh-dev/dsh-genui#c75ca7cec500f7804fdf8be2d43bb970691a89c3')
  })
})

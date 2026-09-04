/** Target-specific Node distribution data used by the desktop runtime builder. */
import { createHash } from 'node:crypto'
import { join } from 'node:path'

export interface DesktopTarget {
  /** Rust target triple consumed by Tauri and Cargo. */
  triple: string
  /** Node.js distribution platform token. */
  nodePlatform: 'darwin' | 'linux' | 'win'
  /** Node.js distribution architecture token. */
  nodeArch: 'arm64' | 'x64'
  /** Platform-default installer formats. */
  bundles: string
  /** Relative executable path inside the extracted Node.js distribution. */
  nodeExecutable: string
}

const TARGETS: Readonly<Record<string, DesktopTarget>> = {
  'x86_64-pc-windows-msvc': {
    triple: 'x86_64-pc-windows-msvc',
    nodePlatform: 'win',
    nodeArch: 'x64',
    bundles: 'msi',
    nodeExecutable: 'node.exe',
  },
  'aarch64-pc-windows-msvc': {
    triple: 'aarch64-pc-windows-msvc',
    nodePlatform: 'win',
    nodeArch: 'arm64',
    bundles: 'msi',
    nodeExecutable: 'node.exe',
  },
  'x86_64-apple-darwin': {
    triple: 'x86_64-apple-darwin',
    nodePlatform: 'darwin',
    nodeArch: 'x64',
    bundles: 'dmg',
    nodeExecutable: 'bin/node',
  },
  'aarch64-apple-darwin': {
    triple: 'aarch64-apple-darwin',
    nodePlatform: 'darwin',
    nodeArch: 'arm64',
    bundles: 'dmg',
    nodeExecutable: 'bin/node',
  },
  'x86_64-unknown-linux-gnu': {
    triple: 'x86_64-unknown-linux-gnu',
    nodePlatform: 'linux',
    nodeArch: 'x64',
    bundles: 'deb,appimage',
    nodeExecutable: 'bin/node',
  },
  'aarch64-unknown-linux-gnu': {
    triple: 'aarch64-unknown-linux-gnu',
    nodePlatform: 'linux',
    nodeArch: 'arm64',
    bundles: 'deb,appimage',
    nodeExecutable: 'bin/node',
  },
}

/** Resolve one supported desktop build target or fail with the complete supported set. */
export function resolveDesktopTarget(triple: string): DesktopTarget {
  const target = TARGETS[triple]
  if (target !== undefined) return target
  throw new Error(`unsupported desktop target ${triple}; expected one of: ${Object.keys(TARGETS).join(', ')}`)
}

/** Return the official Node.js archive name for a desktop target. */
export function nodeArchiveName(version: string, target: DesktopTarget): string {
  const extension = target.nodePlatform === 'win' ? 'zip' : 'tar.gz'
  return `node-v${version}-${target.nodePlatform}-${target.nodeArch}.${extension}`
}

/** Extract the host target triple from `rustc -vV` output. */
export function parseRustHost(verboseVersion: string): string {
  const host = /^host:\s*(\S+)$/m.exec(verboseVersion)?.[1]
  if (host === undefined) throw new Error('rustc -vV did not report a host target')
  return resolveDesktopTarget(host).triple
}

/** Resolve one archive checksum from Node.js SHASUMS256 text. */
export function checksumForArchive(shasums: string, archiveName: string): string {
  for (const line of shasums.split(/\r?\n/)) {
    const [hash, name] = line.trim().split(/\s+/, 2)
    if (hash !== undefined && name === archiveName && /^[a-f0-9]{64}$/.test(hash)) return hash
  }
  throw new Error(`Node.js SHASUMS256.txt does not contain ${archiveName}`)
}

/**
 * Choose a stable Cargo target directory outside a WiX-unsafe checkout path.
 * Tauri 2.11 escapes resource paths in generated WiX XML but leaves several
 * generated EXE/artwork paths literal, so `&`, `<`, and `>` in the target path
 * make candle reject an otherwise valid installer source.
 */
export function wixStagingCargoTargetDirectory(
  repositoryRoot: string,
  temporaryDirectory: string,
  platform: NodeJS.Platform,
): string | undefined {
  const defaultTargetDirectory = join(repositoryRoot, 'apps/desktop/src-tauri/target')
  if (platform !== 'win32' || !/[&<>]/u.test(defaultTargetDirectory)) return undefined
  const fingerprint = createHash('sha256').update(repositoryRoot).digest('hex').slice(0, 12)
  const staged = join(temporaryDirectory, `dsh-desktop-target-${fingerprint}`)
  if (/[&<>]/u.test(staged)) {
    throw new Error(`temporary Cargo target path is not WiX-safe: ${staged}`)
  }
  return staged
}

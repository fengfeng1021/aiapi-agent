/**
 * Tauri file-drop bridge: OS drops arrive as real filesystem paths (the host
 * consumes the drop before the DOM ever sees it), and the host also reports
 * drag enter/leave so the composer can show its drop invitation while a file
 * hovers the window. Images resolve back to bytes for the vision path;
 * everything else drafts a chip whose submit delivers the path as a
 * reference. Outside Tauri the bridge never arms and the DOM drop path stays
 * authoritative.
 * @module conversation/native-picker
 */

import { listen } from '@tauri-apps/api/event'
import { readFile } from '@tauri-apps/plugin-fs'

/** Image extensions the vision intake accepts, mapped to their MIME types. */
const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

/**
 * MIME type for a dropped path's vision intake, or null when the path stays
 * a reference (non-images, or image formats the model pipeline rejects).
 * @param path - absolute OS path from the drop event.
 * @returns image MIME type or null.
 */
export function imageMimeForPath(path: string): string | null {
  const dot = path.toLowerCase().lastIndexOf('.')
  if (dot < 0) return null
  return IMAGE_MIME_BY_EXTENSION[path.slice(dot + 1)] ?? null
}

/** Basename of an OS path across separator styles. */
export function basenameOfPath(path: string): string {
  const base = path.split(/[/\\]/).pop()
  return base === undefined || base === '' ? path : base
}

/** Drop-dispatch faces the bridge calls after path classification. */
export interface TauriDropHandlers {
  /** Whether a drop may land right now (mirrors the DOM drop gate). */
  canAccept: () => boolean
  /** A host file drag entered, moved within, or left the window. */
  onDragActive: (active: boolean) => void
  /** Decoded images ride the existing vision intake. */
  onFiles: (files: readonly File[]) => void
  /** Remaining paths draft file chips (the model receives references). */
  onPaths: (paths: readonly string[]) => void
}

/** Payload shape of the host drag events carrying dropped paths. */
interface TauriDropPayload {
  readonly paths?: readonly string[] | null
}

/**
 * Bridge OS file drags into the composer. Images read back to bytes so they
 * keep previews, rails, and limits; every other path drafts a chip. An
 * unreadable image degrades to a path chip rather than vanishing.
 * @param handlers - acceptance gate, hover reporting, and file/path dispatch.
 * @returns the unlisten function for teardown.
 */
export async function listenTauriFileDrops(
  handlers: TauriDropHandlers,
): Promise<() => void> {
  const settled = await Promise.allSettled([
    listen('tauri://drag-enter', () => { handlers.onDragActive(true) }),
    listen('tauri://drag-over', () => { handlers.onDragActive(true) }),
    listen('tauri://drag-leave', () => { handlers.onDragActive(false) }),
    listen<TauriDropPayload>('tauri://drag-drop', (event) => {
      handlers.onDragActive(false)
      const paths = event.payload.paths ?? []
      if (paths.length === 0 || !handlers.canAccept()) return
      void drainDrop(paths, handlers)
    }),
  ])
  // Partial arming still bridges what it can (hover alone is useful); a host
  // offering nothing usable rejects so the caller keeps the DOM drop path.
  const stops = settled.flatMap(result => (
    result.status === 'fulfilled' && typeof result.value === 'function' ? [result.value] : []
  ))
  if (stops.length === 0) throw new Error('tauri drop events are unavailable')
  return () => {
    for (const stop of stops) stop()
  }
}

/** Classify one drop and dispatch it; read failures degrade to references. */
async function drainDrop(paths: readonly string[], handlers: TauriDropHandlers): Promise<void> {
  const images: File[] = []
  const refs: string[] = []
  for (const path of paths) {
    const mime = imageMimeForPath(path)
    if (mime === null) {
      refs.push(path)
      continue
    }
    try {
      images.push(new File([await readFile(path)], basenameOfPath(path), { type: mime }))
    } catch {
      refs.push(path)
    }
  }
  if (images.length > 0) handlers.onFiles(images)
  if (refs.length > 0) handlers.onPaths(refs)
}

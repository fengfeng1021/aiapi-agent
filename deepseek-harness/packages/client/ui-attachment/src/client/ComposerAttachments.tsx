import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ComposerAttachment, ComposerAttachmentsProps, ComposerImageAttachment,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { AttachmentRail } from '../AttachmentRail.tsx'
import type { AttachmentRailItem } from '../AttachmentRail.tsx'
import { DropOverlay } from '../DropOverlay.tsx'
import { ImageLightbox } from '../ImageLightbox.tsx'
import { attachmentRailLabels, dropOverlayLabels, fileTypeLabel, lightboxLabels } from './labels.ts'
import css from './ComposerAttachments.module.css'

/** Rail item retaining its browser-owned attachment for callbacks. */
type ComposerRailItem = AttachmentRailItem & { attachment: ComposerAttachment }

/** Draft-attachment rail, drop invitation, and original-image preview entry. */
export function ComposerAttachments({
  attachments, canAcceptDrop, dropActive, onAddImages, onRemoveImage, dropLimits, t,
}: ComposerAttachmentsProps) {
  const [preview, setPreview] = useState<ComposerImageAttachment | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const dragDepth = useRef(0)
  const closePreview = useCallback(() => { setPreview(null) }, [])

  useEffect(() => {
    if (preview !== null && !attachments.some(attachment => attachment.id === preview.id)) setPreview(null)
  }, [attachments, preview])

  // The host reports file drags over the window (Tauri events); the DOM path
  // reports them itself in plain browsers. Either one raises the invitation.
  const overlayActive = dragActive || dropActive

  useEffect(() => {
    // Some WebView2 drops report an empty type list while still carrying
    // files, so presence keys off types (cheap) but delivery keys off files
    // (authoritative): an empty list may still be files, a populated
    // non-Files list is never files.
    const maybeFiles = (event: globalThis.DragEvent): boolean => {
      const dataTransfer = event.dataTransfer
      return dataTransfer !== null
        && (dataTransfer.types.length === 0 || dataTransfer.types.includes('Files'))
    }
    const reset = (): void => {
      dragDepth.current = 0
      setDragActive(false)
    }
    const onDragEnter = (event: globalThis.DragEvent): void => {
      if (!maybeFiles(event)) return
      event.preventDefault()
      dragDepth.current += 1
      setDragActive(true)
    }
    const onDragOver = (event: globalThis.DragEvent): void => {
      if (event.dataTransfer === null || !maybeFiles(event)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = canAcceptDrop ? 'copy' : 'none'
    }
    const onDragLeave = (event: globalThis.DragEvent): void => {
      if (!maybeFiles(event)) return
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setDragActive(false)
      const leftViewport = event.clientX <= 0 || event.clientY <= 0
        || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight
      if ((event.target === document.documentElement || event.target === document.body) && leftViewport) reset()
    }
    const onDrop = (event: globalThis.DragEvent): void => {
      const dataTransfer = event.dataTransfer
      if (dataTransfer === null || dataTransfer.files.length === 0) return
      event.preventDefault()
      reset()
      if (canAcceptDrop) onAddImages([...dataTransfer.files])
    }
    document.addEventListener('dragenter', onDragEnter)
    document.addEventListener('dragover', onDragOver)
    document.addEventListener('dragleave', onDragLeave)
    document.addEventListener('drop', onDrop)
    window.addEventListener('dragend', reset)
    return () => {
      document.removeEventListener('dragenter', onDragEnter)
      document.removeEventListener('dragover', onDragOver)
      document.removeEventListener('dragleave', onDragLeave)
      document.removeEventListener('drop', onDrop)
      window.removeEventListener('dragend', reset)
    }
  }, [canAcceptDrop, onAddImages])

  const railItems = useMemo<ComposerRailItem[]>(() => attachments.map((attachment): ComposerRailItem => (
    attachment.kind === 'file'
      ? {
        kind: 'file',
        id: attachment.id,
        name: attachment.name,
        typeLabel: fileTypeLabel(attachment.name, t('file.typeFallback')),
        removeLabel: t('file.remove', { name: attachment.name }),
        attachment,
      }
      : {
        kind: 'image',
        id: attachment.id,
        previewUrl: attachment.previewUrl,
        alt: attachment.file.name || t('image.pending'),
        removeLabel: t('image.remove', { name: attachment.file.name }),
        attachment,
      }
  )), [attachments, t])

  return (
    <>
      {overlayActive && (
        <DropOverlay
          disabled={!canAcceptDrop}
          labels={dropOverlayLabels(t, canAcceptDrop, dropLimits)}
        />
      )}
      {railItems.length > 0 && (
        <div className={css.rail}>
          <AttachmentRail
            items={railItems}
            labels={attachmentRailLabels(t)}
            onOpen={(item) => {
              if (item.attachment.kind === 'image') setPreview(item.attachment)
            }}
            onRemove={(item) => { onRemoveImage(item.attachment.id) }}
          />
        </div>
      )}
      {preview !== null && (
        <ImageLightbox
          src={preview.previewUrl}
          alt={preview.file.name || t('image.original')}
          labels={lightboxLabels(t)}
          onClose={closePreview}
        />
      )}
    </>
  )
}

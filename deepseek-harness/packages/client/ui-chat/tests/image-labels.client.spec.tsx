// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { RenderMessageImages } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { AssistantMarkdown } from '../src/client/chat/AssistantMarkdown.tsx'
import { zh } from '../src/client/locale.ts'

afterEach(cleanup)

const t = makeTranslate(zh, commonZh)

const attachment = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  mediaType: 'image/png' as const,
  bytes: 68,
  width: 640,
  height: 320,
  name: 'history.png',
}

type MessageImagesRenderOwner = Parameters<RenderMessageImages>[0]

function imageRenderer(calls: MessageImagesRenderOwner[]): RenderMessageImages {
  return (owner) => {
    calls.push(owner)
    return (
      <div data-testid="message-images" data-align={owner.align} data-count={owner.images.length}>
        {owner.images.map((entry, index) => {
          if (!('attachment' in entry)) throw new Error('assistant flow images are always durable references')
          const image = entry.attachment
          return <span key={`${image.attachmentId}:${String(index)}`}>{image.name}</span>
        })}
      </div>
    )
  }
}

describe('assistant image slot handoff', () => {
  it('collapses one image group behind a viewed-images row until expanded', () => {
    const calls: MessageImagesRenderOwner[] = []
    const view = render(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'image', attachment }]}
        streaming={false}
        renderMessageImages={imageRenderer(calls)}
      />,
    )
    expect(view.queryByTestId('message-images')).toBeNull()
    expect(calls).toHaveLength(0)
    fireEvent.click(view.getByText('已查看 1 张图片'))
    expect(view.getByTestId('message-images').getAttribute('data-align')).toBe('start')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.images).toEqual([{ attachment }])
  })

  it('merges consecutive image blocks into one group and splits groups at text', () => {
    const calls: MessageImagesRenderOwner[] = []
    const view = render(
      <AssistantMarkdown
        t={t}
        blocks={[
          { kind: 'image', attachment },
          { kind: 'image', attachment },
          { kind: 'text', text: 'between' },
          { kind: 'image', attachment },
        ]}
        streaming={false}
        renderMessageImages={imageRenderer(calls)}
      />,
    )
    expect(view.queryByTestId('message-images')).toBeNull()
    fireEvent.click(view.getByText('已查看 2 张图片'))
    fireEvent.click(view.getByText('已查看 1 张图片'))
    const galleries = view.getAllByTestId('message-images')
    expect(galleries).toHaveLength(2)
    expect(galleries.map(gallery => gallery.getAttribute('data-count'))).toEqual(['2', '1'])
    expect(calls.map(call => call.images.length)).toEqual([2, 1])
  })

  it('keeps the image group position between text blocks after expanding', () => {
    const calls: MessageImagesRenderOwner[] = []
    const view = render(
      <AssistantMarkdown
        t={t}
        blocks={[
          { kind: 'text', text: 'before' },
          { kind: 'image', attachment },
          { kind: 'text', text: 'after' },
        ]}
        streaming={false}
        renderMessageImages={imageRenderer(calls)}
      />,
    )
    fireEvent.click(view.getByText('已查看 1 张图片'))
    const image = view.getByTestId('message-images')
    const before = view.getByText('before')
    const after = view.getByText('after')
    expect(before.compareDocumentPosition(image) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(image.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
  })
})

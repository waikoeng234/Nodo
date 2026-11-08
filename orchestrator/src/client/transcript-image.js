import { h, Fragment, useState, useEffect, call, rightPanelService, ImageLightbox } from './ui-shared.js'
import { HoverPreview, useHoverPreview, useHoverPreviewPlacement } from './hover-preview.tsx'

// Transcript images load by id on mount, so the transcript holds only references.
// With a bound right panel the click opens the image as a tab there; otherwise it
// keeps the host lightbox. Hovering (or focusing) enlarges the loaded thumbnail
// in the shared hover popover without re-requesting the attachment.
export function TranscriptImage({ image }) {
  const [src, setSrc] = useState(null)
  const [error, setError] = useState(false)
  const [preview, setPreview] = useState(false)
  const hover = useHoverPreview()
  const panel = rightPanelService?.getSnapshot().target
  useEffect(() => {
    let live = true
    setSrc(null); setError(false); setPreview(false)
    call('attachment', { id: image.id, mediaType: image.mediaType })
      .then(value => { if (live) setSrc(`data:${value.mediaType};base64,${value.data}`) })
      .catch(() => { if (live) setError(true) })
    return () => { live = false }
  }, [image.id, image.mediaType])
  useHoverPreviewPlacement(hover, 320)
  const alt = image.name || '图片'
  const show = row => { if (src !== null) hover.show(src, row) }
  const open = () => {
    if (!panel) return false
    rightPanelService.openImage({ id: image.id, mediaType: image.mediaType, name: image.name })
    hover.hide()
    return true
  }
  return h(Fragment, null,
    error ? h('span', { className: 'nodo-note', role: 'status' }, `${alt}：图片不可用`)
      : h('button', { type: 'button', className: 'nodo-image-preview', disabled: !src, 'aria-label': `预览 ${alt}`, 'aria-haspopup': 'dialog',
          onClick: () => { if (!open()) setPreview(true) },
          onPointerEnter: event => { if (event.pointerType !== 'touch') show(event.currentTarget) },
          onPointerLeave: hover.close,
          onFocus: event => show(event.currentTarget), onBlur: hover.close },
        src ? h('img', { className: 'nodo-attachment', src, alt, onError: () => setError(true) }) : '正在加载图片…'),
    hover.value !== null && h(HoverPreview, { preview: hover, className: 'nodo-hover-preview nodo-hover-picture', label: alt,
      children: h('img', { src, alt }) }),
    preview && src && h(ImageLightbox, { src, alt, labels: { dialog: '图片预览', close: '关闭预览' }, onClose: () => setPreview(false) }))
}

export const IMAGE_MIME_BY_EXT = Object.freeze({
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
})
export const DISPLAY_IMAGE_MIME_BY_EXT = Object.freeze({ ...IMAGE_MIME_BY_EXT, '.svg': 'image/svg+xml' })
export const IMAGE_EXT_BY_MIME = new Map([
  ['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp'], ['image/gif', 'gif'],
])
export const IMAGE_MIME_TYPES = new Set(Object.values(IMAGE_MIME_BY_EXT))

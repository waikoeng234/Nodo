const PROMPT_SOURCES = new Set(['user', 'steering', undefined])
export const human = message => message?.role === 'user' && PROMPT_SOURCES.has(message.source?.kind)
export const promptKey = message => message.id ?? `${message.source?.kind ?? 'user'}:${JSON.stringify(message.content)}`

export function newestUserInput(messages = [], from = messages.length - 1) {
  for (let i = from; i >= 0; i--) {
    const message = messages[i]
    if (!human(message)) continue
    const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content ?? []
    if (!content.some(block => block.type !== 'text' || block.text.trim())) continue
    const references = []
    for (const context of messages.slice(i + 1)) {
      if (human(context)) break
      if (context.source?.kind === 'session-reference') {
        references.push(context.content.filter(block => block?.type === 'text').map(block => block.text).join('\n\n'))
      }
    }
    return references.length ? [{ type: 'text', text: `${references.join('\n\n')}\n\n# Current task\n` }, ...content] : content
  }
  return null
}

export function newestUserPrompt(messages, from) {
  return newestUserInput(messages, from)?.filter(block => block.type === 'text').map(block => block.text).join('') ?? null
}

export async function engineInput(content, attachments, signal) {
  const text = []
  const images = []
  for (const block of content) {
    signal?.throwIfAborted()
    if (block.type === 'text') text.push(block.text)
    else if (block.type === 'image') {
      if (!attachments?.readImage) throw new Error('Image attachment storage is unavailable')
      if (block.offloaded) {
        const path = attachments.imageHostPath?.(block.attachment)
        text.push(`[Image ${JSON.stringify(block.attachment.name ?? block.attachment.attachmentId)} omitted from image input.${path ? ` Read-only normalized copy: ${JSON.stringify(path)}.` : ' No readable local path is available.'}]`)
      } else {
        const { ref, data } = await attachments.readImage(block.attachment, signal)
        signal?.throwIfAborted()
        images.push({ mediaType: ref.mediaType, data: Buffer.from(data).toString('base64'), ...(ref.name ? { name: ref.name } : {}) })
      }
    } else throw new Error(`Unsupported user content block: ${block.type}`)
  }
  return { text: text.join(''), images }
}

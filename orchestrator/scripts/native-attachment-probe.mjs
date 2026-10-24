import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

async function checkNativeAttachments({ engine, sessionId, observer, nativeCall, until, url, cookie, requests }) {
  const lastInput = () => ({ text: requests.at(-1).messages.flatMap(message => typeof message.content === 'string' ? [message.content] : message.content.filter(block => block.type === 'text').map(block => block.text)).join('\n') })
  const run = async content => {
    const mark = observer.frames.length
    await nativeCall('session/prompt', { request: { sessionId, requestId: `attachment-${engine}-${mark}`, mode: 'queue', content } })
    await until(() => observer.frames.slice(mark).some(frame => frame?.event?.type === 'turn/end'))
    assert.equal(observer.frames.slice(mark).find(frame => frame?.event?.type === 'turn/end').event.data.reason.kind, 'completed', `${engine} attachment turn failed`)
    return lastInput()
  }
  let nativeImageCount = 0
  for (const withText of [true, false]) {
    await run([...(withText ? [{ type: 'text', text: 'ATTACHMENT_CHECK' }] : []), { type: 'image', mediaType: 'image/png', data: PNG, name: 'pixel.png' }])
    const images = requests.at(-1).messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'image') : [])
    assert.ok(images.length > nativeImageCount && images.every(image => image.source?.file_id === 'fixture-image-upload'), 'DSH lost the new image or its provider upload reference')
    nativeImageCount = images.length
  }
  for (const [name, bytes] of [['report.txt', Buffer.from('ATTACHMENT_TEXT_OK')], ['report.pdf', Buffer.from('%PDF-1.4\nATTACHMENT_PDF_OK\n%%EOF')], ['data.bin', Buffer.from([0, 255, 17, 128])]]) {
    const response = await fetch(`${url}/api/session/uploadFileBinary?${new URLSearchParams({ sessionId, name })}`, {
      method: 'POST', signal: AbortSignal.timeout(30000), headers: { Origin: url, Cookie: cookie, 'Content-Type': 'application/octet-stream' }, body: bytes,
    })
    const result = await response.json()
    assert.equal(result.ok, true, `${engine} file upload failed`)
    const input = await run([{ type: 'file', receiptId: result.value.receiptId }])
    const text = input.text ?? input.input.filter(block => block.type === 'text').map(block => block.text).join('')
    assert.ok(text.includes(name), `${engine} lost the file name`)
    const path = [...text.matchAll(/copy saved at ("(?:[^"\\]|\\.)*")/g)].at(-1)?.[1]
    assert.ok(path, `${engine} lost the file read path`)
    assert.deepEqual(readFileSync(JSON.parse(path)), bytes, `${engine} file bytes changed`)
  }
  console.log(`Attachments ${engine}: image+text, image-only, text/PDF/binary file-only uploads passed at the native provider protocol`)
}

export async function checkAttachmentEngine({ engine, api, nativeCall, observe, until, home, url, cookie, requests }) {
  assert.equal(engine, 'dsh', 'Native attachments require the dsh engine')
  const cwd = realpathSync(mkdirSync(join(home, `${engine}-workspace`), { recursive: true }))
  const workspace = await api('workspace-create', { name: 'Attachments', cwd })
  const role = await api('profile-create', { name: `Attachments ${engine}`, engine, workspace: workspace.id })
  const opened = await api('session-open', { profile: role.id, workspace: workspace.id })
  const observer = await observe(opened.sessionId)
  try {
    await checkNativeAttachments({ engine, sessionId: opened.sessionId, observer, nativeCall, until, url, cookie, requests })
  } finally { observer.close() }
}

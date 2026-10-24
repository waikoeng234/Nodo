import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './helpers/client-module.js'

const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flat(Infinity).flatMap(nodes)]
const harness = async call => {
  const { TranscriptImage, host } = await loadClient('feed.js', { call })
  let cursor = 0
  const render = image => { host.reset(); return TranscriptImage({ image }) }
  return { effects: host.effects, render }
}
const image = { id: 'fixture', mediaType: 'image/png', name: 'shot.png' }
const tick = () => new Promise(resolve => setImmediate(resolve))

test('stored images load through the attachment API and open and close the shared lightbox', async () => {
  const requests = []
  const view = await harness(async (endpoint, body) => { requests.push([endpoint, body.id]); return { mediaType: 'image/png', data: 'fixture' } })
  assert.equal(nodes(view.render(image)).find(node => node.type === 'button').props.disabled, true)
  view.effects.shift()()
  await tick()
  let tree = view.render(image)
  assert.deepEqual(requests, [['attachment', 'fixture']])
  assert.equal(nodes(tree).find(node => node.type === 'img').props.src, 'data:image/png;base64,fixture')
  nodes(tree).find(node => node.type === 'button').props.onClick()
  tree = view.render(image)
  const lightbox = nodes(tree).find(node => node.type === 'ImageLightbox')
  assert.equal(lightbox.props.alt, 'shot.png')
  lightbox.props.onClose()
  assert.equal(nodes(view.render(image)).some(node => node.type === 'ImageLightbox'), false)
})

test('missing or undecodable image attachments display an explicit failure', async () => {
  for (const fails of [true, false]) {
    const view = await harness(async () => { if (fails) throw new Error('missing'); return { mediaType: 'image/png', data: 'fixture' } })
    view.render(image)
    view.effects.shift()()
    await tick()
    if (!fails) nodes(view.render(image)).find(node => node.type === 'img').props.onError()
    const status = nodes(view.render(image)).find(node => node.props.role === 'status')
    assert.match(status.children.join(''), /shot.png：图片不可用/)
    assert.equal(nodes(view.render(image)).some(node => node.type === 'img'), false)
  }
})

test('an attachment response received after unmount never updates another image', async () => {
  let resolve
  const view = await harness(() => new Promise(done => { resolve = done }))
  view.render(image)
  const cleanup = view.effects.shift()()
  cleanup()
  resolve({ mediaType: 'image/png', data: 'late' })
  await tick()
  assert.equal(nodes(view.render(image)).some(node => node.type === 'img'), false)
})

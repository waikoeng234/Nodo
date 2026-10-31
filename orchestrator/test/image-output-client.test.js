import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './helpers/client-module.js'

const nodes = node => !node || typeof node !== 'object' ? []
  : [node, ...[...(node.children ?? []), node.props?.children].flat(Infinity).flatMap(nodes)]
const harness = async (call, uiShared) => {
  const { TranscriptImage, HoverPreview, host } = await loadClient(['feed.js', 'hover-preview.tsx'], {
    call, ...(uiShared ? { uiShared: { ...uiShared, call } } : {}), globals: { URL },
  })
  const render = image => { host.reset(); return TranscriptImage({ image }) }
  return { effects: host.effects, host, render, HoverPreview }
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

test('with a bound right panel the click opens an image tab, and hover enlarges the loaded thumbnail without re-requesting', async () => {
  const requests = [], opened = []
  const view = await harness(
    async (endpoint, payload) => { requests.push([endpoint, payload.id]); return { mediaType: 'image/png', data: 'fixture' } },
    { rightPanelService: { subscribe() {}, getSnapshot: () => ({ target: { profile: 'p', session: 's' } }), openImage: value => opened.push(value) } })
  view.render(image)
  view.effects.shift()()
  await tick()
  let tree = view.render(image)
  assert.deepEqual(requests, [['attachment', 'fixture']])
  const button = nodes(tree).find(node => node.type === 'button')
  assert.equal(button.props['aria-haspopup'], 'dialog')
  button.props.onClick()
  assert.deepEqual(JSON.parse(JSON.stringify(opened)), [{ id: 'fixture', mediaType: 'image/png', name: 'shot.png' }])
  assert.equal(nodes(view.render(image)).some(node => node.type === 'ImageLightbox'), false, 'the lightbox stays closed while the panel is bound')
  button.props.onPointerEnter({ pointerType: 'mouse', currentTarget: {} })
  tree = view.render(image)
  const popup = nodes(tree).find(node => node.type === view.HoverPreview)
  assert.equal(popup.props.className, 'nodo-hover-preview nodo-hover-picture')
  assert.equal(popup.props.label, 'shot.png')
  assert.equal(nodes(view.HoverPreview(popup.props)).find(node => node.type === 'img').props.src, 'data:image/png;base64,fixture')
  assert.deepEqual(requests, [['attachment', 'fixture']], 'the enlarged preview reuses the thumbnail src')
  button.props.onFocus({ currentTarget: {} })
  assert.notEqual(nodes(view.render(image)).find(node => node.type === view.HoverPreview), undefined, 'keyboard focus opens the same preview')
})

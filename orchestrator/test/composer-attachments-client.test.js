import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './helpers/client-module.js'

const all = tree => tree && typeof tree === 'object' ? [tree, ...(tree.children ?? []).flatMap(all)] : []

test('mixed attachments remove the selected item even when names repeat, and lock removal while busy or read-only', async () => {
  const { Composer, ComposerAttachments, ComposerAttachmentChip } = await loadClient(['composer.js', 'composer-attachments.tsx'])
  const removed = []
  const props = { value: '', images: [{ name: 'same.png' }], files: [{ id: 'one', name: 'same.png' }, { id: 'two', name: 'same.png' }],
    onRemoveFile: index => removed.push(['file', index]), onRemoveImage: index => removed.push(['image', index]) }
  const tree = Composer(props)
  const row = all(tree).find(item => item.type === ComposerAttachments)
  assert.equal(row.children.length, 3, 'images and documents share one attachment row')
  for (const chip of row.children) {
    const remove = all(ComposerAttachmentChip(chip.props)).find(item => item.type === 'button')
    assert.equal(remove.props.type, 'button', 'removing an attachment never submits the form')
    remove.props.onClick()
  }
  assert.deepEqual(removed, [['file', 0], ['file', 1], ['image', 0]])
  for (const locked of [{ busy: true }, { readOnly: true }]) {
    const chips = all(Composer({ ...props, ...locked })).filter(item => item.type === ComposerAttachmentChip)
    for (const chip of chips) assert.equal(all(ComposerAttachmentChip(chip.props)).find(item => item.type === 'button').props.disabled, true)
  }
  assert.equal(all(Composer({ ...props, images: [], files: [] })).some(item => item.type === ComposerAttachments), false)
})

test('attachment upload state exposes bounded progress and transitions to removal or error details', async () => {
  const { ComposerAttachmentChip } = await loadClient('composer-attachments.tsx')
  const removed = []
  const attachment = { name: 'trace.log', meta: '正在上传', state: 'uploading', progress: 42 }
  const render = value => ComposerAttachmentChip({ attachment: { ...attachment, ...value }, onRemove: name => removed.push(name) })
  const uploading = all(render())
  assert.equal(uploading.find(item => item.props.role === 'progressbar').props['aria-valuenow'], 42)
  assert.ok(uploading.some(item => item.props.role === 'status'))
  assert.equal(uploading.some(item => item.type === 'button'), false)
  for (const [value, expected] of [[-10, 0], [120, 100], [NaN, 0]])
    assert.equal(all(render({ progress: value })).find(item => item.props.role === 'progressbar').props['aria-valuenow'], expected)
  const done = all(render({ state: 'done', meta: '38 KB' }))
  assert.equal(done.some(item => item.props.role === 'progressbar'), false)
  done.find(item => item.type === 'button').props.onClick()
  assert.deepEqual(removed, ['trace.log'])
  const error = render({ state: 'error', meta: '上传失败' })
  assert.equal(error.props['data-state'], 'error')
  assert.ok(all(error).some(item => item.children.includes('上传失败')))
  assert.equal(all(error).some(item => item.type === 'button' || item.props.role === 'progressbar'), false)
})

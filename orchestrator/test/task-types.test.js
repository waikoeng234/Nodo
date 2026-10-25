import { test } from 'node:test'
import assert from 'node:assert/strict'
import defaultTaskTypes from '../core/shared/task-types.json' with { type: 'json' }
import { withHost } from './helpers/host.js'

const refused = async (post, types) => {
  const result = await post('task-types-update', { types })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'orch/invalid')
  return result.error.message
}

test('task types default to the built-in list, ride the view and are never handed out as the imported object', async () => {
  await withHost(async ({ api, runtime }) => {
    const rt = await runtime
    assert.deepEqual(rt.taskTypes(), defaultTaskTypes)
    assert.notEqual(rt.taskTypes(), defaultTaskTypes)
    assert.deepEqual((await api('state')).taskTypes, defaultTaskTypes)
  })
})

test('task-types-update validates the list, generates missing ids and prunes role cards', async () => {
  await withHost(async ({ api, post, runtime }) => {
    const rt = await runtime
    const profile = await api('profile-create', { name: 'Router', engine: 'echo', taskTypes: ['feature', 'docs'] })
    assert.match(await refused(post, [{ name: 'Same', when: '' }, { name: 'same', when: '' }]), /duplicated/)
    assert.match(await refused(post, [{ name: 'x'.repeat(21), when: '' }]), /1 to 20/)
    assert.match(await refused(post, [{ name: 'Long when', when: 'x'.repeat(201) }]), /200/)
    assert.match(await refused(post, Array.from({ length: 21 }, (_, index) => ({ name: `Type ${index}`, when: '' }))), /at most 20/)
    assert.match(await refused(post, [{ id: 'bad id!', name: 'Bad', when: '' }]), /is invalid/)
    assert.match(await refused(post, [{ id: null, name: 'Null id', when: '' }]), /is invalid/)
    assert.match(await refused(post, [{ id: '', name: 'Empty id', when: '' }]), /is invalid/)
    assert.match(await refused(post, [{ id: 'dup', name: 'One', when: '' }, { id: 'dup', name: 'Two', when: '' }]), /is duplicated/)
    assert.match(await refused(post, [{ name: '', when: '' }]), /1 to 20/)
    assert.match(await refused(post, [{ name: 'No when', when: 3 }]), /"when" must be a string/)
    const list = await api('task-types-update', { types: [{ name: ' chore ', when: '' }, { id: 'docs', name: '文档', when: '编写或修改文档' }] })
    assert.deepEqual(list, [{ id: list[0].id, name: 'chore', when: '' }, { id: 'docs', name: '文档', when: '编写或修改文档' }])
    assert.match(list[0].id, /^[\w-]{1,40}$/)
    assert.notEqual(list[0].id, 'docs')
    assert.deepEqual(rt.taskTypes(), list)
    assert.deepEqual(rt.findProfile(profile.id).taskTypes, ['docs'])
    await assert.rejects(api('profile-update', { id: profile.id, changes: { taskTypes: ['feature'] } }), { code: 'orch/invalid' })
    assert.deepEqual(await api('task-types-update', { types: [] }), [])
    assert.equal(Object.hasOwn(rt.findProfile(profile.id), 'taskTypes'), false)
    await assert.rejects(api('profile-create', { name: 'Late', engine: 'echo', taskTypes: ['docs'] }), { code: 'orch/invalid' })
  })
})

test('findTaskType resolves by id and loosely by name, and misses unknowns', async () => {
  await withHost(async ({ runtime }) => {
    const rt = await runtime
    assert.equal(rt.findTaskType('feature')?.id, 'feature')
    assert.equal(rt.findTaskType('功能')?.id, 'feature')
    assert.equal(rt.findTaskType(' 功能 ')?.id, 'feature')
    assert.equal(rt.findTaskType('"功能"')?.id, 'feature')
    assert.equal(rt.findTaskType('no-such-type'), undefined)
    assert.equal(rt.findTaskType(undefined), undefined)
    assert.equal(rt.findTaskType(null), undefined)
  })
})

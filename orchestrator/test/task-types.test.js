import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import defaultTaskTypes from '../core/shared/task-types.json' with { type: 'json' }
import { boot, withHost } from './helpers/host.js'

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
    assert.deepEqual(list, [{ id: list[0].id, name: 'chore', when: '', splitDifficulty: false }, { id: 'docs', name: '文档', when: '编写或修改文档', splitDifficulty: false }])
    assert.match(list[0].id, /^[\w-]{1,40}$/)
    assert.notEqual(list[0].id, 'docs')
    assert.deepEqual(rt.taskTypes(), list)
    assert.deepEqual(rt.findProfile(profile.id).taskTypes, ['docs'])
    await assert.rejects(api('profile-update', { id: profile.id, changes: { taskTypes: ['feature'] } }), { code: 'orch/invalid' })
    assert.equal(await refused(post, []), '至少保留一个任务类型')
    assert.deepEqual(rt.taskTypes(), list, 'a refused empty list leaves the catalog untouched')
    await api('task-types-update', { types: [list[0]] })
    assert.equal(Object.hasOwn(rt.findProfile(profile.id), 'taskTypes'), false)
    await assert.rejects(api('profile-create', { name: 'Late', engine: 'echo', taskTypes: ['docs'] }), { code: 'orch/invalid' })
  })
})

test('splitDifficulty defaults off, validates, persists and rides the view', async () => {
  await withHost(async ({ api, post, runtime, home }) => {
    const rt = await runtime
    assert.ok(rt.taskTypes().every(item => item.splitDifficulty === false))
    assert.ok((await api('state')).taskTypes.every(item => item.splitDifficulty === false))
    for (const value of ['yes', 1, null]) assert.match(await refused(post, [{ name: 'Chore', when: '', splitDifficulty: value }]), /splitDifficulty/)
    const saved = await api('task-types-update', { types: [{ name: 'Chore', when: '', splitDifficulty: true }] })
    assert.equal(saved[0].splitDifficulty, true)
    assert.equal(rt.taskTypes()[0].splitDifficulty, true)
    const restart = join(home, 'reload')
    mkdirSync(restart)
    copyFileSync(join(home, 'state.json'), join(restart, 'state.json'))
    const reloaded = boot(restart)
    try {
      const restored = await reloaded.runtime
      await restored.load()
      assert.equal(restored.taskTypes()[0].splitDifficulty, true, 'the switch survives a reload from disk')
    } finally { reloaded.dispose() }
    const { splitDifficulty, ...rest } = saved[0]
    const reset = await api('task-types-update', { types: [{ ...rest, name: 'Renamed' }] })
    assert.deepEqual(reset[0], { id: saved[0].id, name: 'Renamed', when: '', splitDifficulty: false })
    const kept = await api('task-types-update', { types: [{ ...reset[0], splitDifficulty: true }] })
    assert.equal(kept[0].splitDifficulty, true)
    rt.state.prefs.taskTypes = [{ id: 'legacy', name: 'Legacy', when: '' }]
    assert.deepEqual(rt.taskTypes(), [{ id: 'legacy', name: 'Legacy', when: '', splitDifficulty: false }], 'stored types without the field read as split off')
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

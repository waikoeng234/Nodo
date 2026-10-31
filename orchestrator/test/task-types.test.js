import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withHost } from './helpers/host.js'

const refused = async (post, teams) => {
  const result = await post('teams-update', { teams })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'orch/invalid')
  return result.error.message
}

// The catalog lives on each team now: teams-update validates every team's own
// types, an empty catalog is fine, and ids only have to be unique within one
// team.
test('teams-update validates each team\'s task types and leaves empty catalogs alone', async () => {
  await withHost(async ({ api, post, runtime }) => {
    const rt = await runtime
    const member = await api('profile-create', { name: 'Router', engine: 'echo' })
    const team = (types, assign = {}) => ({ name: 'Team', lead: null, members: [member.id], types, assign })
    assert.match(await refused(post, [team([{ name: 'Same', when: '' }, { name: 'same', when: '' }])]), /duplicated/)
    assert.match(await refused(post, [team([{ name: 'x'.repeat(21), when: '' }])]), /1 to 20/)
    assert.match(await refused(post, [team([{ name: 'Long when', when: 'x'.repeat(201) }])]), /200/)
    assert.match(await refused(post, [team(Array.from({ length: 21 }, (_, index) => ({ name: `Type ${index}`, when: '' })))]), /at most 20/)
    assert.match(await refused(post, [team([{ id: 'bad id!', name: 'Bad', when: '' }])]), /is invalid/)
    assert.match(await refused(post, [team([{ id: null, name: 'Null id', when: '' }])]), /is invalid/)
    assert.match(await refused(post, [team([{ id: 'dup', name: 'One', when: '' }, { id: 'dup', name: 'Two', when: '' }])]), /is duplicated/)
    assert.match(await refused(post, [team([{ name: '', when: '' }])]), /1 to 20/)
    assert.match(await refused(post, [team([{ name: 'No when', when: 3 }])]), /"when" must be a string/)
    assert.match(await refused(post, [team([], { docs: { normal: { profile: member.id } } })]), /unknown task type/)
    assert.equal(await post('teams-update', { teams: [team([{ name: 'Same', when: '' }]), team([{ name: 'same', when: '' }])] }).then(result => result.ok), true,
      'names and ids stay independent across teams')
    // A new team starts without any type; the assignment page adds them in place.
    const empty = await api('teams-update', { teams: [{ ...team([]), id: 'empty' }] })
    assert.deepEqual(empty[0].types, [])
    const list = await api('teams-update', { teams: [team([{ name: ' chore ', when: '' }, { id: 'docs', name: '文档', when: '编写或修改文档' }],
      { docs: { normal: { profile: member.id } } })] })
    assert.deepEqual(list[0].types, [{ id: list[0].types[0].id, name: 'chore', when: '' }, { id: 'docs', name: '文档', when: '编写或修改文档' }])
    assert.match(list[0].types[0].id, /^[\w-]{1,40}$/)
    assert.notEqual(list[0].types[0].id, 'docs')
    assert.deepEqual(rt.teams()[0].types, list[0].types)
    assert.equal((await api('state')).taskTypes, undefined, 'the view no longer carries a global catalog')
  })
})

test('removing a team type in the same save clears the assignments that referenced it', async () => {
  await withHost(async ({ api, runtime }) => {
    const rt = await runtime
    const member = await api('profile-create', { name: 'Router', engine: 'echo' })
    const types = [{ id: 'docs', name: '文档', when: '' }, { id: 'ops', name: '运维', when: '' }]
    await api('teams-update', { teams: [{ name: 'Team', lead: null, members: [member.id], types,
      assign: { docs: { normal: { profile: member.id } }, ops: { normal: { profile: member.id } } } }] })
    await api('teams-update', { teams: [rt.teams()[0]].map(item => ({ ...item, types: item.types.filter(type => type.id !== 'ops'),
      assign: Object.fromEntries(Object.entries(item.assign).filter(([id]) => id !== 'ops')) })) })
    assert.deepEqual(rt.teams()[0].types.map(type => type.id), ['docs'])
    assert.deepEqual(Object.keys(rt.teams()[0].assign), ['docs'])
    // Defensive twin of the client's cleanup: pruning drops assignments whose
    // type no longer sits in the team.
    rt.teams()[0].assign.ops = { normal: { profile: member.id } }
    rt.pruneTeams()
    assert.deepEqual(Object.keys(rt.teams()[0].assign), ['docs'])
  })
})

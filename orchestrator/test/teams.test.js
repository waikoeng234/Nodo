import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withHost } from './helpers/host.js'

const refused = async (post, teams) => {
  const result = await post('teams-update', { teams })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'orch/invalid')
  return result.error.message
}

const roles = async api => {
  const a = await api('profile-create', { name: 'A', engine: 'echo' })
  const b = await api('profile-create', { name: 'B', engine: 'echo' })
  const lead = await api('profile-create', { name: 'Lead', engine: 'claude', lead: true })
  const other = await api('profile-create', { name: 'Other', engine: 'claude', lead: true })
  return { lead, other, a, b }
}

test('teams-update validates, normalizes and rides the view', async () => {
  await withHost(async ({ api, post, runtime }) => {
    const rt = await runtime
    const { lead, other, a, b } = await roles(api)
    const team = { name: 'Delivery', lead: lead.id, members: [a.id, b.id], assign: {} }
    assert.match(await refused(post, 'x'), /list of at most/)
    assert.match(await refused(post, [{ ...team, name: 'x'.repeat(21) }]), /at most 20/)
    assert.match(await refused(post, [{ ...team, lead: a.id }]), /must be a lead role/)
    assert.match(await refused(post, [team, { ...team, name: 'Again' }]), /only one team/)
    assert.match(await refused(post, [{ ...team, members: [lead.id] }]), /distinct executor roles/)
    assert.match(await refused(post, [{ ...team, members: [a.id, a.id] }]), /distinct executor roles/)
    assert.match(await refused(post, [{ ...team, assign: { nope: { normal: { profile: a.id } } } }]), /unknown task type/)
    assert.match(await refused(post, [{ ...team, assign: { feature: { normal: { profile: 'ghost' } } } }]), /member of the team/)
    assert.match(await refused(post, [{ ...team, assign: { feature: { normal: { profile: a.id, model: 'bad\nmodel' } } } }]), /Invalid model/)
    assert.match(await refused(post, [{ id: 'dup', ...team }, { id: 'dup', ...team, lead: other.id }]), /is invalid/)
    const saved = await api('teams-update', { teams: [
      { ...team, assign: { feature: { normal: { profile: a.id, model: 'm1' }, hard: { profile: b.id, thinking: 'high' } }, docs: { normal: {} } } },
      { name: '', lead: null, members: [b.id], assign: {} },
    ] })
    assert.match(saved[0].id, /^[\w-]{1,40}$/)
    assert.deepEqual(saved[0].assign, { feature: { normal: { profile: a.id, model: 'm1' }, hard: { profile: b.id, thinking: 'high' } }, docs: { normal: {} } })
    assert.deepEqual(rt.teams(), saved)
    assert.deepEqual((await api('state')).teams, saved)
    assert.equal(rt.teamOf(lead.id).name, 'Delivery')
    assert.equal(rt.teamOf(other.id), undefined)
  })
})

test('deleting a role or a type and demoting a lead prune team references', async () => {
  await withHost(async ({ api, runtime }) => {
    const rt = await runtime
    const { lead, a, b } = await roles(api)
    await api('teams-update', { teams: [{ name: 'Delivery', lead: lead.id, members: [a.id, b.id], assign: {
      feature: { normal: { profile: a.id }, hard: { profile: b.id, model: 'm1' } }, docs: { normal: { profile: b.id } } } }] })
    await api('profile-delete', { id: a.id })
    assert.deepEqual(rt.teams()[0].members, [b.id])
    assert.deepEqual(rt.teams()[0].assign.feature, { normal: {}, hard: { profile: b.id, model: 'm1' } })
    await api('task-types-update', { types: rt.taskTypes().filter(item => item.id !== 'docs') })
    assert.deepEqual(Object.keys(rt.teams()[0].assign), ['feature'])
    await api('profile-update', { id: lead.id, changes: { lead: false } })
    assert.equal(rt.teams()[0].lead, null)
  })
})

test('the first read derives one team per lead from the legacy role settings and drops them', async () => {
  await withHost(async ({ api, runtime }) => {
    const rt = await runtime
    const { lead, a, b } = await roles(api)
    Object.assign(rt.state.profiles[a.id], { taskTypes: ['feature', 'docs'] })
    Object.assign(rt.state.profiles[b.id], { taskTypes: ['feature', 'review'], hard: { model: 'hard-model', thinking: 'high' } })
    rt.state.prefs.taskTypes = [
      { id: 'feature', name: '功能', when: '', splitDifficulty: true }, { id: 'docs', name: '文档', when: '' }, { id: 'review', name: '审查', when: '' }]
    const teams = rt.teams()
    assert.equal(teams.length, 2)
    assert.deepEqual(teams.map(team => [team.name, team.lead]).sort(), [['Lead', lead.id], ['Other', teams.find(team => team.name === 'Other').lead]])
    assert.deepEqual(teams[0].members, [a.id, b.id])
    assert.deepEqual(teams[0].assign, {
      feature: { normal: { profile: a.id }, hard: { profile: b.id, model: 'hard-model', thinking: 'high' } },
      docs: { normal: { profile: a.id } },
      review: { normal: { profile: b.id } },
    })
    assert.equal(rt.teams(), teams, 'the derived list is stored')
    for (const id of [a.id, b.id]) assert.equal(Object.hasOwn(rt.state.profiles[id], 'taskTypes') || Object.hasOwn(rt.state.profiles[id], 'hard'), false)
    assert.equal(rt.taskTypes().some(item => 'splitDifficulty' in item), false)
  })
})

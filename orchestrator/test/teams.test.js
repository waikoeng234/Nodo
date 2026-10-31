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
    const team = { name: 'Delivery', lead: lead.id, members: [a.id, b.id], types: [{ id: 'feature', name: '功能', when: '' }, { id: 'docs', name: '文档', when: '' }], assign: {} }
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

test('one executor role sits in several teams at once', async () => {
  await withHost(async ({ api, runtime }) => {
    const rt = await runtime
    const { lead, other, a } = await roles(api)
    const saved = await api('teams-update', { teams: [
      { name: 'First', lead: lead.id, members: [a.id], types: [], assign: {} },
      { name: 'Second', lead: other.id, members: [a.id], types: [], assign: {} },
    ] })
    assert.deepEqual(saved.map(team => team.members), [[a.id], [a.id]])
    assert.deepEqual((await api('state')).teams.map(team => team.members), [[a.id], [a.id]])
    assert.equal(rt.teams().length, 2)
  })
})

test('a teams-update without the types field keeps the stored types of existing teams', async () => {
  await withHost(async ({ api, runtime }) => {
    const rt = await runtime
    const { lead, a } = await roles(api)
    const types = [{ id: 'feature', name: '功能', when: '' }]
    await api('teams-update', { teams: [{ id: 'build', name: 'build', lead: lead.id, members: [a.id], types,
      assign: { feature: { normal: { profile: a.id } } } }] })
    // A stale client page submits the old team shape without a types field.
    const saved = await api('teams-update', { teams: [
      { id: 'build', name: 'build 2', lead: lead.id, members: [a.id], assign: { feature: { normal: { profile: a.id } } } }] })
    assert.deepEqual(saved[0].types, types, 'a missing field inherits the stored catalog')
    assert.deepEqual(rt.teams()[0].types, types)
    // Only an explicit array replaces the catalog: empty stays empty (the client
    // clears the assignments of removed types in the same save).
    const cleared = await api('teams-update', { teams: [{ ...saved[0], types: [], assign: {} }] })
    assert.deepEqual(cleared[0].types, [])
    // A brand-new team without the field starts empty.
    const fresh = await api('teams-update', { teams: [cleared[0], { name: 'new', lead: null, members: [a.id], assign: {} }] })
    assert.deepEqual(fresh[1].types, [])
  })
})

test('old-format state is migrated before a stale teams-update or a prune touches it', async () => {
  await withHost(async ({ api, runtime }) => {
    const rt = await runtime
    const { lead, a } = await roles(api)
    rt.state.prefs.teams = [{ id: 'build', name: 'build', lead: lead.id, members: [a.id], assign: { feature: { normal: { profile: a.id } } } }]
    rt.state.prefs.taskTypes = [{ id: 'feature', name: '功能', when: '用户改过的说明' }]
    const saved = await api('teams-update', { teams: [{ id: 'build', name: 'build', lead: lead.id, members: [a.id], assign: { feature: { normal: { profile: a.id } } } }] })
    assert.deepEqual(saved[0].types, [{ id: 'feature', name: '功能', when: '用户改过的说明' }], 'the stored catalog reaches the team before the submit is cleaned')
    assert.equal(rt.state.prefs.taskTypes, undefined)
  })
  await withHost(async ({ api, runtime }) => {
    const rt = await runtime
    const { lead, a } = await roles(api)
    rt.state.prefs.teams = [{ id: 'build', name: 'build', lead: lead.id, members: [a.id], assign: { feature: { normal: { profile: a.id } } } }]
    rt.state.prefs.taskTypes = [{ id: 'feature', name: '功能', when: '' }]
    // A profile change prunes; the teams list has never been read yet.
    await api('profile-update', { id: a.id, changes: { name: 'A2' } })
    assert.deepEqual(rt.teams()[0].assign, { feature: { normal: { profile: a.id } } }, 'pruning first migrates, so assignments survive')
    assert.deepEqual(rt.teams()[0].types.map(type => type.id), ['feature'])
    assert.equal(rt.state.prefs.taskTypes, undefined)
  })
})

test('deleting a role or a team type and demoting a lead prune team references', async () => {
  await withHost(async ({ api, runtime }) => {
    const rt = await runtime
    const { lead, a, b } = await roles(api)
    const types = [{ id: 'feature', name: '功能', when: '' }, { id: 'docs', name: '文档', when: '' }]
    await api('teams-update', { teams: [{ name: 'Delivery', lead: lead.id, members: [a.id, b.id], types, assign: {
      feature: { normal: { profile: a.id }, hard: { profile: b.id, model: 'm1' } }, docs: { normal: { profile: b.id } } } }] })
    await api('profile-delete', { id: a.id })
    assert.deepEqual(rt.teams()[0].members, [b.id])
    assert.deepEqual(rt.teams()[0].assign.feature, { normal: {}, hard: { profile: b.id, model: 'm1' } })
    await api('teams-update', { teams: [{ ...rt.teams()[0], types: types.filter(type => type.id !== 'docs'),
      assign: Object.fromEntries(Object.entries(rt.teams()[0].assign).filter(([id]) => id !== 'docs')) }] })
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
    for (const team of teams) {
      assert.deepEqual(team.types.map(({ id, name, when }) => ({ id, name, when })),
        [{ id: 'feature', name: '功能', when: '' }, { id: 'docs', name: '文档', when: '' }, { id: 'review', name: '审查', when: '' }],
        'each derived team carries the old catalog as its own types')
      assert.ok(team.types.every(type => !('splitDifficulty' in type)))
    }
    assert.equal(rt.state.prefs.taskTypes, undefined, 'the shared catalog leaves prefs')
  })
})

test('the first read over existing teams copies the shared catalog into every team', async () => {
  await withHost(async ({ api, runtime }) => {
    const rt = await runtime
    const { lead, other, a, b } = await roles(api)
    rt.state.prefs.teams = [
      { id: 't1', name: 'Delivery', lead: lead.id, members: [a.id], assign: { feature: { normal: { profile: a.id } } } },
      { id: 't2', name: 'Again', lead: other.id, members: [b.id], assign: {} },
    ]
    rt.state.prefs.taskTypes = [{ id: 'feature', name: '功能', when: '用户改过的说明' }, { id: 'docs', name: '文档', when: '' }]
    const teams = rt.teams()
    for (const team of teams) {
      assert.deepEqual(team.types, [{ id: 'feature', name: '功能', when: '用户改过的说明' }, { id: 'docs', name: '文档', when: '' }],
        'the user-edited catalog lands in every team with its ids intact')
      assert.equal(Object.hasOwn(team, 'assign') && 'feature' in team.assign, team.id === 't1', 'existing assignments stay untouched')
    }
    assert.equal(rt.state.prefs.taskTypes, undefined)
    assert.notEqual(teams[0].types, teams[1].types, 'teams do not share the list object')
    assert.equal(rt.findTeamType(teams[0], '功能')?.id, 'feature')
    assert.equal(rt.findTeamType(teams[0], 'no-such-type'), undefined)
  })
  await withHost(async ({ api, runtime }) => {
    const rt = await runtime
    const { lead, a } = await roles(api)
    rt.state.prefs.teams = [{ id: 't1', name: 'Delivery', lead: lead.id, members: [a.id], assign: {} }]
    const teams = rt.teams()
    assert.match(teams[0].types[0].id, /^[\w-]{1,40}$/, 'without a stored catalog the built-in defaults seed every team')
    assert.ok(teams[0].types.some(type => type.id === 'feature'))
  })
})

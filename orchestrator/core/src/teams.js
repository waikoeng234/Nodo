// Teams: a lead, its members, the task types the team routes with and the
// per-type assignment table lead routing reads. The list lives in prefs.teams.
// The first read after upgrading derives one team per lead from the per-role
// taskTypes/hard settings those used to carry, and the first read after the
// per-team switch copies the shared catalog into every team, then drops it.
import { randomUUID } from 'node:crypto'
import { TEAMS_MAX, TEAM_NAME_MAX, TASK_TYPES_MAX, TASK_TYPE_NAME_MAX, TASK_TYPE_WHEN_MAX } from './constants.js'
import { normalize, unquote } from './text.js'
import { cleanModel, cleanThinking } from './profiles.js'
import defaultTaskTypes from '../shared/task-types.json' with { type: 'json' }

const invalid = message => Object.assign(new Error(message), { code: 'orch/invalid' })

export function install(rt) {
  const { state } = rt
  const live = () => Object.values(state.profiles).filter(profile => !profile.deletedAt)

  const derive = () => {
    const roster = live().filter(profile => profile.lead !== true)
    const types = Array.isArray(state.prefs.taskTypes) ? state.prefs.taskTypes : defaultTaskTypes
    const catalog = types.map(({ id, name, when }) => ({ id, name, when }))
    const teams = live().filter(profile => profile.lead === true).map(lead => {
      const assign = {}
      for (const type of types) {
        const holders = roster.filter(profile => profile.taskTypes?.includes(type.id))
        const normal = (type.splitDifficulty ? holders.find(profile => profile.hard === undefined) : undefined) ?? holders[0]
        const hard = type.splitDifficulty ? holders.find(profile => profile.hard !== undefined) : undefined
        if (!normal && !hard) continue
        assign[type.id] = {
          ...(normal ? { normal: { profile: normal.id } } : {}),
          ...(type.splitDifficulty ? { hard: { ...(hard ? { profile: hard.id, ...hard.hard } : {}) } } : {}),
        }
      }
      return { id: randomUUID(), name: lead.name, lead: lead.id, members: roster.map(profile => profile.id), types: catalog.map(type => ({ ...type })), assign }
    })
    for (const profile of Object.values(state.profiles)) { delete profile.taskTypes; delete profile.hard }
    delete state.prefs.taskTypes
    return teams
  }

  const teams = () => {
    if (!Array.isArray(state.prefs.teams)) state.prefs.teams = derive()
    else migrate()
    return state.prefs.teams
  }
  const teamOf = leadId => teams().find(team => team.lead === leadId)

  // First read of per-switch data: every team that predates team.types copies
  // the shared catalog (the user's edits or the built-in defaults) with its ids
  // intact, then the shared catalog leaves prefs. Mutates memory only; the next
  // save persists it, and until then every re-read migrates the same way.
  const migrate = () => {
    if (!Array.isArray(state.prefs.teams) || !state.prefs.teams.some(team => !Array.isArray(team.types))) return
    const catalog = (Array.isArray(state.prefs.taskTypes) ? state.prefs.taskTypes : defaultTaskTypes)
      .map(({ id, name, when }) => ({ id, name, when }))
    for (const team of state.prefs.teams) team.types = catalog.map(type => ({ ...type }))
    delete state.prefs.taskTypes
  }

  const cleanTypes = list => {
    if (!Array.isArray(list) || list.length > TASK_TYPES_MAX) throw invalid(`Task types must be a list of at most ${TASK_TYPES_MAX} items`)
    const ids = new Set(), names = new Set()
    return list.map(item => {
      const name = unquote(item?.name)
      if (name === '' || name.length > TASK_TYPE_NAME_MAX) throw invalid(`A task type name must be 1 to ${TASK_TYPE_NAME_MAX} characters`)
      if (names.has(normalize(name))) throw invalid(`Task type name "${name}" is duplicated`)
      if (typeof item.when !== 'string' || item.when.length > TASK_TYPE_WHEN_MAX) throw invalid(`A task type "when" must be a string of at most ${TASK_TYPE_WHEN_MAX} characters`)
      let { id } = item
      if (id === undefined) id = randomUUID()
      else {
        if (typeof id !== 'string' || !/^[\w-]{1,40}$/.test(id)) throw invalid(`Task type id "${id}" is invalid`)
        if (ids.has(id)) throw invalid(`Task type id "${id}" is duplicated`)
      }
      ids.add(id)
      names.add(normalize(name))
      return { id, name, when: item.when }
    })
  }

  // Delegation names a type by id or loosely by name, within the lead's team.
  const findTeamType = (team, ref) => {
    if (ref === undefined || ref === null) return undefined
    const types = Array.isArray(team.types) ? team.types : []
    return types.find(item => item.id === ref)
      ?? types.find(item => normalize(item.name) === normalize(unquote(ref)))
  }

  const cleanPick = (raw, members, label) => {
    if (raw === undefined || raw === null) return undefined
    if (typeof raw !== 'object' || Array.isArray(raw)) throw invalid(`${label} must be an object`)
    const pick = {}
    if (raw.profile !== undefined && raw.profile !== '') {
      if (!members.includes(raw.profile)) throw invalid(`${label} must name a member of the team`)
      pick.profile = raw.profile
    }
    const model = cleanModel(raw.model), thinking = cleanThinking(raw.thinking)
    if (model !== undefined) pick.model = model
    if (thinking !== undefined) pick.thinking = thinking
    return pick
  }

  const cleanTeams = list => {
    if (!Array.isArray(list) || list.length > TEAMS_MAX) throw invalid(`Teams must be a list of at most ${TEAMS_MAX} items`)
    const cards = new Map(live().map(profile => [profile.id, profile]))
    const stored = new Map((state.prefs.teams ?? []).map(team => [team.id, team]))
    const ids = new Set(), leads = new Set()
    return list.map(item => {
      const name = unquote(item?.name ?? '')
      if (name.length > TEAM_NAME_MAX) throw invalid(`A team name must be at most ${TEAM_NAME_MAX} characters`)
      let id = item.id
      if (id === undefined) id = randomUUID()
      else if (typeof id !== 'string' || !/^[\w-]{1,40}$/.test(id) || ids.has(id)) throw invalid(`Team id "${id}" is invalid`)
      ids.add(id)
      const lead = item.lead ?? null
      if (lead !== null) {
        if (cards.get(lead)?.lead !== true) throw invalid('A team lead must be a lead role')
        if (leads.has(lead)) throw invalid('A lead can lead only one team')
        leads.add(lead)
      }
      if (!Array.isArray(item.members) || new Set(item.members).size !== item.members.length || item.members.some(member => !cards.has(member) || cards.get(member).lead === true)) {
        throw invalid('Team members must be distinct executor roles')
      }
      // A submit without the field (a stale page) inherits the stored catalog;
      // only an explicit array replaces it, and a brand-new team starts empty.
      const previous = stored.get(id)?.types
      const types = Array.isArray(item.types) ? cleanTypes(item.types)
        : Array.isArray(previous) ? previous.map(type => ({ ...type })) : []
      const typeIds = new Set(types.map(type => type.id))
      const assign = {}
      for (const [type, entry] of Object.entries(item.assign ?? {})) {
        if (!typeIds.has(type)) throw invalid('A team assignment names an unknown task type id')
        const normal = cleanPick(entry?.normal, item.members, 'normal'), hard = cleanPick(entry?.hard, item.members, 'hard')
        if (normal !== undefined || hard !== undefined) assign[type] = { ...(normal !== undefined ? { normal } : {}), ...(hard !== undefined ? { hard } : {}) }
      }
      return { id, name, lead, members: [...item.members], types, assign }
    })
  }

  const updateTeams = async list => {
    await rt.load()
    // Migrate before cleaning so a submit without types inherits the catalog
    // instead of finding unmigrated teams.
    migrate()
    state.prefs.teams = cleanTeams(list)
    await rt.save()
    return state.prefs.teams
  }

  // Drops what no longer exists: removed roles, a role that became a lead or
  // stopped being one, and assignments whose type left the team.
  const pruneTeams = () => {
    if (!Array.isArray(state.prefs.teams)) return
    // Pruning reads team.types; migrate first so old-format state keeps its
    // assignments instead of meeting an empty id list.
    migrate()
    const cards = new Map(live().map(profile => [profile.id, profile]))
    for (const team of state.prefs.teams) {
      if (team.lead !== null && cards.get(team.lead)?.lead !== true) team.lead = null
      team.members = team.members.filter(member => cards.has(member) && cards.get(member).lead !== true)
      const typeIds = new Set((team.types ?? []).map(type => type.id))
      for (const type of Object.keys(team.assign)) {
        if (!typeIds.has(type)) { delete team.assign[type]; continue }
        for (const key of ['normal', 'hard']) {
          const pick = team.assign[type][key]
          if (pick?.profile !== undefined && !team.members.includes(pick.profile)) delete pick.profile
        }
      }
    }
  }

  Object.assign(rt, { teams, teamOf, updateTeams, pruneTeams, findTeamType })
}

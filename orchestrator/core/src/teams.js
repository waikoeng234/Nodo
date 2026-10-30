// Teams: a lead, its members and the per-type assignment table lead routing
// reads. The list lives in prefs.teams. The first read after upgrading derives
// one team per lead from the per-role taskTypes/hard settings and the per-type
// difficulty split those used to carry, then drops those fields.
import { randomUUID } from 'node:crypto'
import { TEAMS_MAX, TEAM_NAME_MAX } from './constants.js'
import { unquote } from './text.js'
import { cleanModel, cleanThinking } from './profiles.js'

const invalid = message => Object.assign(new Error(message), { code: 'orch/invalid' })

export function install(rt) {
  const { state } = rt
  const live = () => Object.values(state.profiles).filter(profile => !profile.deletedAt)

  const derive = () => {
    const roster = live().filter(profile => profile.lead !== true)
    const types = Array.isArray(state.prefs.taskTypes) ? state.prefs.taskTypes : rt.taskTypes()
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
      return { id: randomUUID(), name: lead.name, lead: lead.id, members: roster.map(profile => profile.id), assign }
    })
    for (const profile of Object.values(state.profiles)) { delete profile.taskTypes; delete profile.hard }
    if (Array.isArray(state.prefs.taskTypes)) state.prefs.taskTypes = state.prefs.taskTypes.map(({ splitDifficulty, ...type }) => type)
    return teams
  }

  const teams = () => {
    if (!Array.isArray(state.prefs.teams)) state.prefs.teams = derive()
    return state.prefs.teams
  }
  const teamOf = leadId => teams().find(team => team.lead === leadId)

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
    const typeIds = new Set(rt.taskTypes().map(type => type.id))
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
      const assign = {}
      for (const [type, entry] of Object.entries(item.assign ?? {})) {
        if (!typeIds.has(type)) throw invalid('A team assignment names an unknown task type id')
        const normal = cleanPick(entry?.normal, item.members, 'normal'), hard = cleanPick(entry?.hard, item.members, 'hard')
        if (normal !== undefined || hard !== undefined) assign[type] = { ...(normal !== undefined ? { normal } : {}), ...(hard !== undefined ? { hard } : {}) }
      }
      return { id, name, lead, members: [...item.members], assign }
    })
  }

  const updateTeams = async list => {
    await rt.load()
    state.prefs.teams = cleanTeams(list)
    await rt.save()
    return state.prefs.teams
  }

  // Drops what no longer exists: removed roles, a role that became a lead or
  // stopped being one, and task types that left the catalog.
  const pruneTeams = () => {
    if (!Array.isArray(state.prefs.teams)) return
    const cards = new Map(live().map(profile => [profile.id, profile]))
    const typeIds = new Set(rt.taskTypes().map(type => type.id))
    for (const team of state.prefs.teams) {
      if (team.lead !== null && cards.get(team.lead)?.lead !== true) team.lead = null
      team.members = team.members.filter(member => cards.has(member) && cards.get(member).lead !== true)
      for (const type of Object.keys(team.assign)) {
        if (!typeIds.has(type)) { delete team.assign[type]; continue }
        for (const key of ['normal', 'hard']) {
          const pick = team.assign[type][key]
          if (pick?.profile !== undefined && !team.members.includes(pick.profile)) delete pick.profile
        }
      }
    }
  }

  Object.assign(rt, { teams, teamOf, updateTeams, pruneTeams })
}

// The task-type catalog lead routing classifies work with. The user's edited
// list lives in prefs.taskTypes; until then the built-in defaults apply, handed
// out as a copy so the imported JSON stays pristine. Role cards reference the
// types by id, so replacing the list prunes ids that no longer exist.
import { randomUUID } from 'node:crypto'
import { TASK_TYPES_MAX, TASK_TYPE_NAME_MAX, TASK_TYPE_WHEN_MAX } from './constants.js'
import { normalize, unquote } from './text.js'
import defaultTaskTypes from '../shared/task-types.json' with { type: 'json' }

const invalid = message => Object.assign(new Error(message), { code: 'orch/invalid' })

export function install(rt) {
  const { state } = rt

  const taskTypes = () => Array.isArray(state.prefs.taskTypes)
    ? state.prefs.taskTypes.map(item => item.splitDifficulty === undefined ? { ...item, splitDifficulty: false } : item)
    : defaultTaskTypes.map(item => ({ ...item }))

  const findTaskType = ref => {
    if (ref === undefined || ref === null) return undefined
    const types = taskTypes()
    return types.find(item => item.id === ref)
      ?? types.find(item => normalize(item.name) === normalize(unquote(ref)))
  }

  const updateTaskTypes = async list => {
    await rt.load()
    if (!Array.isArray(list) || list.length > TASK_TYPES_MAX) throw invalid(`Task types must be a list of at most ${TASK_TYPES_MAX} items`)
    if (!list.length) throw invalid('至少保留一个任务类型')
    const ids = new Set(), names = new Set()
    const types = list.map(item => {
      const name = unquote(item?.name)
      if (name === '' || name.length > TASK_TYPE_NAME_MAX) throw invalid(`A task type name must be 1 to ${TASK_TYPE_NAME_MAX} characters`)
      if (names.has(normalize(name))) throw invalid(`Task type name "${name}" is duplicated`)
      if (typeof item.when !== 'string' || item.when.length > TASK_TYPE_WHEN_MAX) throw invalid(`A task type "when" must be a string of at most ${TASK_TYPE_WHEN_MAX} characters`)
      if (item.splitDifficulty !== undefined && typeof item.splitDifficulty !== 'boolean') throw invalid('A task type "splitDifficulty" must be a boolean')
      let { id } = item
      if (id === undefined) id = randomUUID()
      else {
        if (typeof id !== 'string' || !/^[\w-]{1,40}$/.test(id)) throw invalid(`Task type id "${id}" is invalid`)
        if (ids.has(id)) throw invalid(`Task type id "${id}" is duplicated`)
      }
      ids.add(id)
      names.add(normalize(name))
      return { id, name, when: item.when, splitDifficulty: item.splitDifficulty === true }
    })
    state.prefs.taskTypes = types
    const known = new Set(types.map(item => item.id))
    for (const profile of Object.values(state.profiles)) {
      if (!Array.isArray(profile.taskTypes)) continue
      const kept = profile.taskTypes.filter(id => known.has(id))
      if (kept.length === 0) delete profile.taskTypes
      else if (kept.length !== profile.taskTypes.length) profile.taskTypes = kept
    }
    await rt.save()
    return types
  }

  Object.assign(rt, { taskTypes, findTaskType, updateTaskTypes })
}

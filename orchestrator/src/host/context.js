import { INSTRUCTIONS_MAX, TRANSCRIPT_TEXT_MAX } from './constants.js'
import { clip } from './text.js'
import { transcriptReplies } from './session-references.js'

const invalid = message => Object.assign(new Error(message), { code: 'orch/invalid' })

export function install(rt) {
  const cleanTaskState = raw => {
    if (raw === null) return null
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('Task state must be an object or null')
    const state = {}
    if (raw.objective !== undefined) {
      if (typeof raw.objective !== 'string') throw invalid('Task objective must be text')
      state.objective = raw.objective
    }
    for (const key of ['completed', 'evidence', 'pending', 'next']) {
      if (raw[key] === undefined) continue
      if (!Array.isArray(raw[key]) || raw[key].length > 20 || raw[key].some(item => typeof item !== 'string')) throw invalid(`Task ${key} must be a list of at most 20 texts`)
      state[key] = [...raw[key]]
    }
    if (JSON.stringify(state).length > INSTRUCTIONS_MAX) throw invalid('Task state is too long')
    return rt.redactDeepSecrets(state)
  }

  const sessionReference = async (raw = {}) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('Reference must identify a source session')
    const { profile: ref, session: id, limit = 10 } = raw
    const profile = rt.findProfile(ref)
    if (!profile) throw invalid('Choose a valid source profile')
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw invalid('Reference limit must be between 1 and 20')
    const { session } = rt.conversation(profile.id, id)
    await rt.loadSecrets()
    const nativeId = session.engine === 'dsh' ? session.driverSessionId : undefined
    const reports = nativeId && typeof rt.ctx.sessionController?.inspect === 'function'
      ? (await rt.referenceReplies({ profile: profile.id, session: session.id })).messages.slice(0, limit).reverse()
      : transcriptReplies(rt.transcriptOf(session.id)).slice(-limit)
    const max = Math.floor(TRANSCRIPT_TEXT_MAX / Math.max(reports.length, 1))
    return rt.redactDeepSecrets({
      source: { kind: 'agent', profileId: profile.id, profileName: session.profileName ?? profile.name, sessionId: session.id, sessionName: session.name },
      messages: reports.map(line => ({ at: line.at, text: line.text.slice(0, max), ...(line.text.length > max ? { truncated: true } : {}) })),
    })
  }

  const recordTaskOutcome = (id, task, reason, report) => {
    const found = rt.conversationOf(id)
    if (!found || task === null) return
    found.session.lastTurn = rt.redactDeepSecrets({ task: clip(rt.redactDeepSecrets(task), INSTRUCTIONS_MAX, 'last task'), reason,
      report: clip(rt.redactDeepSecrets(report ?? ''), INSTRUCTIONS_MAX, 'last report'), at: Date.now() })
  }

  Object.assign(rt, { cleanTaskState, sessionReference, recordTaskOutcome })
}

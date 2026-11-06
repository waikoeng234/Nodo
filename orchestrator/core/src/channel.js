// POST /api/nodo: one endpoint name and payload per request, answered as
// { ok: true, value } or { ok: false, error }. `state` returns only the live parts
// while the client's revision is current.
import { leadModeOf } from '../shared/lead.js'
import { failure, invalid } from './errors.js'

const BUGS = [TypeError, ReferenceError, RangeError, SyntaxError]
// Bugs and system errors (ENOENT, EACCES…) are recorded with their stack; any other
// error was thrown on purpose and its message is for the user.
function errorCode(error) {
  const code = typeof error?.code === 'string' ? error.code : ''
  if (code.startsWith('orch/')) return code
  return BUGS.some(type => error instanceof type) || /^E[A-Z_]+$/.test(code) ? 'orch/internal' : 'orch/refused'
}

// 增量应答里的行做同样的脱敏；appended/changed 的行对象换成脱敏副本，位置原样保留。
function redactDelta(rt, delta) {
  if (delta.full) return { ...delta, lines: rt.redactDeepSecrets(delta.lines) }
  return { ...delta, appended: rt.redactDeepSecrets(delta.appended), changed: rt.redactDeepSecrets(delta.changed) }
}

export function install(rt) {
  const { ctx, state } = rt
  // What a new view carries. Secret values never leave the host; profiles carry
  // only the names of the keys they may use. `struct` moves only when the saved
  // shape changes; `activity` also moves while turns run.
  const view = () => {
    // The state view strips executions; each task keeps its newest one's status
    // so cards can tell 未确认 from 受阻 without a task-get round trip.
    const latest = new Map(Object.values(state.executions).map(execution => [execution.taskId, execution.status]))
    return {
      struct: rt.versions().struct,
      activity: rt.versions().activity,
      probe: state.probe,
      workspaces: rt.workspacesView(),
      profiles: rt.profilesView(),
      secrets: rt.secretsView(),
      teams: rt.teams(),
      decisions: rt.decisionsView(),
      tasks: rt.redactDeepSecrets(Object.values(state.tasks).map(({ brief, source, acceptances, ...task }) => ({
        ...task, latestExecutionStatus: latest.get(task.id) ?? null }))),
      prefs: state.prefs,
      readOnly: rt.readOnly() ?? null,
    }
  }
  // Sent with every state answer, current or not: work, cards and counters move
  // between revisions.
  const live = async () => ({
    work: rt.workView(),
    approvals: rt.approvalsView(),
    stats: rt.statsView(),
    sessions: rt.sessionActivity(),
  })

  // Endpoints a read-only host still serves. Cards are answered from this host's
  // memory, not the file, so a reading window keeps them.
  const READS = new Set(['state', 'task-list', 'task-get', 'decision-list', 'decision-get', 'engines', 'engine-catalog', 'engine-detect', 'engine-check', 'engine-commands', 'workspace-files', 'workspace-dir', 'workspace-file', 'worktree-refs', 'workspace-git', 'workspace-diff', 'transcript', 'stream-detail', 'session-reference', 'reference-replies', 'reference-read', 'reference-history', 'diag', 'approval-answer', 'probe', 'attachment'])

  const resolveProfileRef = (ref) => {
    const profile = rt.findProfile(ref)
    if (profile === undefined) throw invalid(`No profile "${ref}"`)
    return profile
  }

  const answer = async (endpoint, body) => {
    await rt.refresh()
    const readOnly = rt.readOnly()
    if (readOnly !== undefined && !READS.has(endpoint)) throw failure(readOnly, 'orch/read-only')
    switch (endpoint) {
      case 'decision-list':
      case 'decision-get':
      case 'decision-answer':
      case 'decision-cancel': {
        const { session } = rt.conversation(resolveProfileRef(body.profile).id, body.session)
        if (endpoint === 'decision-list') return rt.listDecisions(session.id)
        if (endpoint === 'decision-get') return rt.getDecision(session.id, body.decisionId)
        if (endpoint === 'decision-answer') return rt.answerDecision(session.id, body)
        return rt.cancelDecision(session.id, body)
      }
      case 'task-list': {
        const workspaceRef = body.workspace === undefined ? undefined : rt.findWorkspace(body.workspace)?.id ?? body.workspace
        const executions = new Map()
        for (const execution of Object.values(state.executions)) {
          const list = executions.get(execution.taskId)
          if (list) list.push(execution)
          else executions.set(execution.taskId, [execution])
        }
        return rt.redactDeepSecrets(Object.values(state.tasks).filter(task => (workspaceRef === undefined || task.workspaceRef === workspaceRef)
          && (body.teamId === undefined || task.teamId === body.teamId)).map(({ brief, source, acceptances, ...task }) => {
          const list = executions.get(task.id) ?? []
          return { ...task, latestExecutionStatus: list.at(-1)?.status ?? null,
            executions: list.map(({ sessionId, createdAt, startedAt, endedAt }) => ({ sessionId, createdAt, startedAt, endedAt })) }
        }))
      }
      case 'task-get': {
        const task = await rt.taskView(body.taskId)
        if (body.workspace !== undefined && (rt.findWorkspace(body.workspace)?.id ?? body.workspace) !== task.workspaceRef
          || body.teamId !== undefined && body.teamId !== task.teamId) throw invalid('Task is outside the requested scope')
        return rt.redactDeepSecrets(task)
      }
      case 'state': {
        await rt.driversReady()
        await rt.loadSecrets()
        await rt.refreshNativeStatus?.()
        const { struct, activity } = rt.versions()
        if (body.since?.struct === struct) return { struct, activity, unchanged: true, ...(await live()) }
        return { ...view(), ...(await live()) }
      }
      case 'engines':
        await rt.driversReady()
        return rt.listEngines()
      case 'engine-catalog':
        await rt.driversReady()
        return rt.engineCatalogView()
      case 'engine-detect':
        await rt.driversReady()
        return rt.engineDetectView()
      case 'engine-scan':
        await rt.load()
        return rt.scanEngineCatalog(String(body.engine ?? ''))
      case 'engine-commands': {
        await rt.driversReady()
        const engine = String(body.engine ?? '')
        const cwd = (body.workspace !== undefined ? rt.findWorkspace(body.workspace)?.cwd : undefined)
          ?? rt.workspacesView()[0]?.cwd ?? rt.home
        return rt.scanEngineCommands({ engine, engineOptions: rt.engineConfig(engine).engineOptions, cwd })
      }
      case 'workspace-files':
        return rt.workspaceFiles({ workspace: body.workspace, query: body.query })
      case 'workspace-file':
        return rt.workspaceFile(body)
      case 'workspace-dir':
        return rt.workspaceDir(body)
      case 'worktree-refs':
        return rt.worktreeRefs(body)
      case 'workspace-git':
        return rt.workspaceGit(body)
      case 'workspace-diff':
        return rt.workspaceDiff(body)
      case 'workspace-switch':
        return rt.workspaceSwitch(body)
      case 'engine-check': {
        await rt.driversReady()
        const cwd = body.cwd ?? rt.workspacesView()[0]?.cwd ?? rt.home
        return rt.checkEngine({ ...body, cwd })
      }
      case 'engine-config-set':
        return rt.saveEngineConfig(body)
      case 'engine-enable-set':
        return rt.saveEngineEnables(body)
      case 'diag':
        return rt.diagView()
      case 'transcript': {
        await rt.load()
        const profile = Object.hasOwn(state.profiles, body.profile) ? state.profiles[body.profile] : resolveProfileRef(body.profile)
        const { session } = rt.conversation(profile.id, body.session)
        let lines = body.since === undefined || session.archivedAt ? rt.transcriptOf(session.id) : []
        const archived = !lines.length && session.archivedAt
        if (archived && body.since?.archived) return { unchanged: true }
        if (archived) {
          try { lines = (await rt.readHostTranscript?.(session)) ?? lines } catch {}
        }
        await rt.loadSecrets()
        if (body.since === undefined) return rt.redactDeepSecrets(lines)
        return archived ? { archived: true, lines: rt.redactDeepSecrets(lines) } : redactDelta(rt, rt.transcriptDelta(session.id, body.since))
      }
      case 'session-reference':
        return rt.sessionReference(body)
      case 'stream-detail':
        return rt.readStreamDetail(body)
      case 'reference-replies':
        return rt.referenceReplies(body)
      case 'reference-create':
        return rt.createReference(body)
      case 'reference-read':
        return rt.readReference(body)
      case 'reference-bind':
        return rt.bindReference(body)
      case 'reference-history':
        return rt.referenceHistory(body)
      case 'probe':
        return rt.runProbe()
      case 'workspace-create':
        await rt.load()
        return rt.createWorkspace({ name: body.name, cwd: body.cwd })
      case 'workspace-update':
        await rt.load()
        return rt.updateWorkspace(body.id, body.changes ?? body)
      case 'workspace-delete':
        await rt.load()
        return rt.deleteWorkspace(body.id ?? body.workspace)
      case 'worktree-create':
        return rt.createWorktree(body)
      case 'profile-create':
        await rt.driversReady()
        return rt.createProfile(body)
      case 'profile-update':
        await rt.driversReady()
        return rt.updateProfile(body.id, body.changes ?? body)
      case 'profile-delete':
        await rt.load()
        return rt.deleteProfile(body.id ?? body.profile)
      case 'profile-order':
        return rt.orderProfiles(body.ids)
      case 'role-preset-save':
        return rt.saveRolePreset(body)
      case 'role-preset-delete':
        return rt.deleteRolePreset(body)
      case 'teams-update':
        return rt.updateTeams(body.teams)
      case 'session-create':
        return rt.createSession(resolveProfileRef(body.profile).id, body.name, body.workspace, body.lazy === true, body.draft === true, body.choices, undefined,
          { team: body.team !== false })
      case 'session-open':
        return rt.openNativeSession(body)
      case 'session-select':
        return rt.selectSession(resolveProfileRef(body.profile).id, body.session).then(session => {
          void rt.flushLeadReports(session.id)
          return session
        })
      case 'session-update':
        return rt.updateSession(resolveProfileRef(body.profile).id, body.session, body.changes ?? {})
      case 'session-archive':
        return rt.archiveSession(resolveProfileRef(body.profile).id, body.session, body.archived === true)
      case 'send': {
        await rt.load()
        if (body.mode !== undefined && body.mode !== 'queue') throw invalid('Unknown send mode')
        const profile = resolveProfileRef(body.profile)
        const { session } = rt.conversation(profile.id, body.session)
        rt.assertSessionWritable(profile, session)
        const task = body.taskId !== undefined ? await rt.ownedTask({ profile, session }, body.taskId) : undefined
        const goalStarted = await rt.applySessionGoal(profile, session)
        const cwd = session.cwd ?? rt.sessionWorkspace(profile, session)?.cwd
        const leadMode = leadModeOf(profile, session)
        const images = leadMode && cwd ? await rt.materializeImages(rt.admitImages(body.images), cwd) : []
        const files = body.files?.length || images.length ? { refs: body.files?.length ? rt.cleanFileRefs(body.files) : undefined,
          paths: [...await rt.materializeFiles(body.files, cwd), ...images] } : undefined
        const scope = task ? `补充任务 ${task.id} · ${rt.redactDeepSecrets(task.title)}` : ''
        const brief = [leadMode ? rt.leadBrief(profile, session) : '', scope].filter(Boolean).join('\n\n')
        const placed = await rt.send(profile.id, body.text, body.session, body.images, body.references,
          { files, userInput: true, queue: goalStarted || body.mode === 'queue', ...(task ? { origin: { kind: 'task', taskId: task.id } } : {}),
            ...(brief ? { brief } : {}) })
        if (leadMode) void rt.followLead(session.id, placed)
        else void rt.followLeadReport(session.id, placed, placed.leadFlight)
        if (leadMode) await rt.resumeDecisionDelivery?.(session.id)
        void rt.flushLeadReports(session.id)
        return { profileId: profile.id, mode: placed.mode, seq: placed.seq }
      }
      case 'queued-message': {
        await rt.load()
        const profile = resolveProfileRef(body.profile)
        return rt.queuedMessage(profile.id, body.session, body.seq, body.action)
      }
      case 'attachment':
        return rt.imageOf(body)
      case 'attachment-save': {
        const images = rt.admitImages(body.images), files = rt.admitFiles(body.files)
        return { images: await rt.saveImages(images), files: await rt.saveFiles(files) }
      }
      case 'attachment-place': {
        const cwd = rt.findWorkspace(body.workspace)?.cwd
        if (cwd === undefined) throw invalid(`No workspace "${body.workspace}"`)
        const files = await rt.materializeFiles(body.files, cwd)
        return { files, text: files.length > 0
          ? ['## Attached files (user provided)', ...files.map(file => `- ${JSON.stringify(file)}`)].join('\n') : '' }
      }
      case 'interrupt': {
        await rt.load()
        const profile = resolveProfileRef(body.profile)
        return rt.interrupt(profile.id, body.session)
      }
      case 'session-compact': {
        await rt.load()
        const profile = resolveProfileRef(body.profile)
        const { session } = rt.conversation(profile.id, body.session)
        rt.assertSessionWritable(profile, session)
        return rt.compactDriver(session.id)
      }
      case 'approval-answer':
        await rt.answerApproval(body.id, { decision: body.decision, value: body.value })
        return true
      case 'secret-set':
        return rt.secretSet(body)
      case 'secret-delete':
        return rt.secretDelete(body)
      default:
        throw failure(`Unknown endpoint ${endpoint}`, 'orch/not-found')
    }
  }

  const handle = (endpoint, payload) => answer(endpoint, payload ?? {}).then(value => ({ ok: true, value }), (error) => {
    const code = errorCode(error)
    const message = error?.message ?? String(error)
    if (code === 'orch/internal') rt.noteFailure({ source: 'api', text: `${endpoint}: ${message}`, code: error?.code ?? error?.name, stack: error?.stack })
    return { ok: false, error: { code, message, details: {} } }
  })

  rt.handle = handle
  rt.sessionActivity = () => Object.fromEntries(Object.values(state.profiles).flatMap(profile => rt.sessionsOf(profile)
    .filter(session => rt.transcriptInfo(session.id).at > 0 || session.lastActiveAt > 0)
    .map(session => [session.id, {
      driverSessionId: session.driverSessionId, briefSent: session.briefSent, cwd: session.cwd, workspaceRef: rt.sessionWorkspace(profile, session)?.id,
      instructionMode: session.instructionMode, instructionTarget: session.instructionTarget,
      updatedAt: Math.max(rt.transcriptInfo(session.id).at, session.lastActiveAt ?? 0) || session.createdAt,
    }])))
  rt.liveSnapshot = () => ({ ...rt.versions(), work: rt.workView(), approvals: rt.approvalsView(), stats: rt.statsView(), readOnly: rt.readOnly() ?? null, sessions: rt.sessionActivity() })

  ctx.effect(() => {
    rt.load().catch(() => {})
    return () => {}
  }, 'nodo: load state')
}

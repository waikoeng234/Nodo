// POST /api/nodo: one endpoint name and payload per request, answered as
// { ok: true, value } or { ok: false, error }. `state` returns only the live parts
// while the client's revision is current.
import { ROUTE } from './constants.js'

const failure = (message, code) => Object.assign(new Error(message), { code })
const invalid = message => failure(message, 'orch/invalid')
const BUGS = [TypeError, ReferenceError, RangeError, SyntaxError]
// Bugs and system errors (ENOENT, EACCES…) are recorded with their stack; any other
// error was thrown on purpose and its message is for the user.
export function errorCode(error) {
  const code = typeof error?.code === 'string' ? error.code : ''
  if (code.startsWith('orch/')) return code
  return BUGS.some(type => error instanceof type) || /^E[A-Z_]+$/.test(code) ? 'orch/internal' : 'orch/refused'
}

export function install(rt) {
  const { ctx, state } = rt

  // What a new view carries. Secret values never leave the host; profiles carry
  // only the names of the keys they may use.
  const view = () => ({
    revision: state.revision,
    probe: state.probe,
    workspaces: rt.workspacesView(),
    profiles: rt.profilesView(),
    secrets: rt.secretsView(),
    workflows: rt.workflowsView(),
    prefs: state.prefs,
    readOnly: rt.readOnly() ?? null,
  })
  // Sent with every state answer, current or not: work, cards and counters move
  // between revisions. Unfinished runs come as summaries; a reading window has no
  // fresh copy of their files, so it gets none.
  const live = async () => ({
    work: rt.workView(),
    approvals: rt.approvalsView(),
    stats: rt.statsView(),
    runs: rt.readOnly() !== undefined ? [] : (await rt.listRuns().catch(() => [])).filter(run => !['done', 'failed', 'cancelled', 'unreadable'].includes(run.status)),
  })

  // A run outlives the request: the answer comes once it is saved and moving, and
  // a failure after that is only logged.
  const begin = start => new Promise((resolve, reject) => {
    let begun = false
    const started = (run) => { begun = true; resolve(run.id) }
    start(started).then(started, (error) => {
      if (begun) rt.warn('nodo: workflow run stopped: %s', error?.message ?? error)
      else reject(error)
    })
  })

  // Endpoints a read-only host still serves. Cards are answered from this host's
  // memory, not the file, so a reading window keeps them.
  const READS = new Set(['state', 'engines', 'engine-catalog', 'engine-detect', 'engine-check', 'engine-commands', 'workspace-files', 'workspace-file', 'worktree-refs', 'transcript', 'stream-detail', 'session-reference', 'reference-replies', 'reference-read', 'reference-history', 'diag', 'approval-answer', 'probe', 'adapter-models', 'attachment'])

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
      case 'state':
        await rt.driversReady()
        await rt.loadSecrets()
        await rt.refreshNativeStatus()
        if (body.since === state.revision) return { revision: state.revision, unchanged: true, ...(await live()) }
        return { ...view(), ...(await live()) }
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
      case 'worktree-refs':
        return rt.worktreeRefs(body)
      case 'engine-check':
        await rt.driversReady()
        return rt.checkEngine(body)
      case 'engine-config-set':
        return rt.saveEngineConfig(body)
      case 'engine-enable-set':
        return rt.saveEngineEnables(body)
      case 'diag':
        return rt.diagView()
      case 'transcript': {
        await rt.load()
        const profile = resolveProfileRef(body.profile)
        return rt.transcriptOf(rt.conversation(profile.id, body.session).session.id)
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
      case 'role-preset-save':
        return rt.saveRolePreset(body)
      case 'role-preset-delete':
        return rt.deleteRolePreset(body)
      case 'session-create':
        return rt.createSession(resolveProfileRef(body.profile).id, body.name, body.workspace, body.lazy === true, body.draft === true, body.choices)
      case 'adapter-session-open':
        return rt.openAdapterSession(body)
      case 'adapter-models':
        return rt.adapterModels(body)
      case 'adapter-model-select':
        return rt.selectAdapterModel(body)
      case 'session-open':
        return rt.openNativeSession(body)
      case 'session-select':
        return rt.selectSession(resolveProfileRef(body.profile).id, body.session)
      case 'session-update':
        return rt.updateSession(resolveProfileRef(body.profile).id, body.session, body.changes ?? {})
      case 'session-archive':
        return rt.archiveSession(resolveProfileRef(body.profile).id, body.session, body.archived === true)
      case 'send': {
        await rt.load()
        const profile = resolveProfileRef(body.profile)
        const placed = await rt.send(profile.id, body.text, body.session, body.images, body.references)
        return { profileId: profile.id, mode: placed.mode, seq: placed.seq }
      }
      case 'attachment':
        return rt.imageOf(body)
      case 'attachment-save': {
        const images = rt.admitImages(body.images), files = rt.admitFiles(body.files)
        return { images: await rt.saveImages(images), files: await rt.saveFiles(files) }
      }
      case 'interrupt': {
        await rt.load()
        const profile = resolveProfileRef(body.profile)
        return rt.interrupt(profile.id, body.session)
      }
      case 'session-compact': {
        await rt.load()
        const profile = resolveProfileRef(body.profile)
        return rt.compactDriver(rt.conversation(profile.id, body.session).session.id)
      }
      case 'approval-answer':
        await rt.answerApproval(body.id, { decision: body.decision, value: body.value, exit: body.exit })
        return true
      case 'secret-set':
        return rt.secretSet(body)
      case 'secret-delete':
        return rt.secretDelete(body)
      case 'workflow-create':
        await rt.load()
        return rt.defineWorkflow(body)
      case 'workflow-update':
        return rt.updateWorkflow(body)
      case 'workflow-delete':
        return rt.deleteWorkflow(body.id)
      case 'workflow-run':
        await rt.load()
        if (rt.state.workflows[String(body.id ?? '')] === undefined) throw failure('No such workflow', 'orch/not-found')
        return { started: true, runId: await begin(started => rt.runWorkflow(body.id, { started, title: body.title })) }
      case 'run-list':
        return rt.listRuns()
      case 'run-get':
        return rt.getRun(body.id)
      case 'run-cancel':
        await rt.cancelRun(body.id, { reason: body.reason })
        return rt.getRun(body.id)
      case 'run-reconcile':
        await begin(started => rt.reconcileRun(body.id, { action: body.action, text: body.text, reason: body.reason, started }))
        return rt.getRun(body.id)
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

  // The browser reaches these routes with its dsh session cookie; /api/orchestrator is the old name.
  for (const path of [ROUTE, '/api/orchestrator']) ctx.effect(() => ctx.connection.fetch.register({
    path,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const { endpoint, payload } = (await request.json().catch(() => null)) ?? {}
      return Response.json(await handle(String(endpoint ?? ''), payload))
    },
  }), 'nodo: api route')

  ctx.effect(() => {
    rt.load().catch(() => {})
    return () => {}
  }, 'nodo: load state')
}

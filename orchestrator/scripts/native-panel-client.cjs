const { createElement: h, useEffect, useRef, useState } = require('react')
const { Button, IconUsersOutlineRegular } = require('@deepseek-ai/dsh-client-ui-primitives')
const PANEL = 'nodo-native-panel-probe'
let rememberedRole = 'Native integration'

function apply(ctx) {
  const currentId = () => ctx.uiSession.adapter.current.getSnapshot().key
  async function openBaseline() {
    await ctx.sessions.refresh()
    const baseline = Object.values(ctx.sessions.list.getSnapshot().byId).find(session => session.title === 'Native plain baseline')
    if (!baseline) throw new Error('Baseline session unavailable')
    ctx.uiWorkspace.openSession(baseline.id)
  }
  function Panel({ SessionProvider, renderSlot, usePanelInfo }) {
    const [role, setRole] = useState(rememberedRole)
    const [reference, setReference] = useState(null)
    const [error, setError] = useState('')
    const [evidence, setEvidence] = useState(null)
    const baseline = useRef(currentId())
    const panel = usePanelInfo(info => info.activePanelId)
    useEffect(() => {
      let canceled = false
      let acquired
      void (async () => {
        const response = await fetch('/api/nodo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: 'state' }) })
        const state = await response.json()
        if (!state.ok) throw new Error('Cannot read probe roles')
        const profile = state.value.profiles.find(profile => profile.name === role)
        const session = profile?.sessions.find(session => session.driverSessionId)
        if (!session) throw new Error('Native session unavailable')
        acquired = ctx.sessions.retain(session.driverSessionId, { source: 'workspaceOperation' })
        await acquired.ready
        if (canceled) acquired.release()
        else setReference(acquired)
      })().catch(error => { acquired?.release(); if (!canceled) setError(error.message) })
      return () => { canceled = true }
    }, [role])
    useEffect(() => () => reference?.release(), [reference])
    const choose = next => {
      if (next === role) return
      rememberedRole = next
      setReference(null)
      setError('')
      setEvidence(null)
      setRole(next)
    }
    const inspect = () => ({
      independentPanelActive: panel === PANEL,
      embeddedSessionId: reference?.sessionId,
      hostSelectionUnchanged: currentId() === baseline.current,
      rightbarHasSession: ctx.sidebarRight.mounted.getSnapshot() !== undefined,
      rightbarMatchesEmbedded: reference !== null && ctx.sidebarRight.mounted.getSnapshot() === reference.sessionId,
    })
    const openRight = () => {
      try {
        ctx.sidebarRight.openTab('browser')
        setEvidence({ ...inspect(), rightbarOpened: true })
      } catch (error) {
        setEvidence({ ...inspect(), rightbarOpened: false, reason: error.message })
      }
    }
    return h('section', { 'data-nodo-native-panel': '', 'data-role': role, style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
      h('header', { style: { padding: 16, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
        h('strong', null, 'Nodo 原生组合验证'),
        h(Button, { size: 'sm', onClick: () => choose('Native integration') }, '面板 coder'),
        h(Button, { size: 'sm', onClick: () => choose('Native reviewer') }, '面板 reviewer'),
        h(Button, { size: 'sm', onClick: openRight }, '尝试打开原生右栏'),
        h(Button, { size: 'sm', onClick: () => ctx.layout.selectPanel(null) }, '退出到原生空间')),
      h('div', { role: 'status', style: { padding: '0 16px' } }, error || role),
      evidence && h('output', { 'data-panel-probe-evidence': '', style: { padding: 16, overflowWrap: 'anywhere' } }, JSON.stringify(evidence)),
      reference && h(SessionProvider, { session: reference }, renderSlot('nodo.probe.conversation', {})))
  }
  function Conversation({ useSession, useConversation, renderFactorySlot }) {
    const session = useSession(value => value)
    const conversation = useConversation(value => value)
    const active = conversation.activeTargets.size > 0 || !session.blank && !session.awaitingFirstTurn || session.running
    const hero = !active && session.openState === 'open'
    return renderFactorySlot('conversation.content', { variant: 'embedded', phase: active ? 'active' : hero ? 'hero' : 'settling', hero })
  }
  ctx.slots.inject('main', function* () {
    yield ctx.slots.register({ name: 'main', key: PANEL, children: { 'nodo.probe.conversation': { kind: 'single', scope: 'session' } } }, Panel)
    yield ctx.slots.register({ name: 'nodo.probe.conversation' }, Conversation)
  })
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 2, label: 'Nodo 组合验证' }, () => h(IconUsersOutlineRegular)))
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'nodo-panel-baseline' }, () => h(Button, { size: 'sm', onClick: () => void openBaseline() }, '原生基准会话')))
}

module.exports = { inject: ['slots', 'sessions', 'uiSession', 'uiWorkspace', 'layout', 'sidebarRight'], apply }

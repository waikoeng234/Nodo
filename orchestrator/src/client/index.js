const inject = ['slots', 'uiWorkspace', 'uiSession', 'sessions', 'layout', 'modelDirectories', 'remote', 'remote.session', 'commandUi', 'inputTriggers', 'conversation']

function apply(ctx) {
  nativePickDirectory = typeof ctx.uiWorkspace?.pickDirectory === 'function' ? () => ctx.uiWorkspace.pickDirectory() : null
  nativeSpace = createNativeSpace(ctx, NodoSidebar)
  createModelSeat(ctx, nativeSpace)
  createRoleSeat(ctx, nativeSpace)
  const { ReferenceDock, ReferenceDialog, installHistory } = createSessionReferences(ctx, nativeSpace)
  ;({ NewConversation } = createNewConversation(ctx, nativeSpace, ReferenceDialog))
  nativeSessionState = ctx.uiSession.adapter.current
  completionTracker = createCompletionTracker({ getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) }, window)
  ctx.effect(() => () => completionTracker.dispose(), 'nodo: completion read state')
  openNativeSession = id => nativeSpace.open(id)
  layoutService = ctx.layout
  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = CSS + REFERENCE_CSS + WORKFLOW_CSS
    document.head.appendChild(style)
    return () => style.remove()
  }, 'nodo: page styles')
  ctx.slots.inject('conversation.input.dock', () => {
    const stops = [
      ctx.slots.register({ name: 'conversation.input.dock', id: 'nodo-running', order: -100 }, NativeRunningDock),
      ctx.slots.register({ name: 'conversation.input.dock', id: 'nodo-references', order: -90 }, ReferenceDock),
    ]
    return () => { for (const stop of stops) stop() }
  })
  ctx.slots.inject('conversation.chat.node', installHistory)
  ctx.slots.inject('tool.call.toolview', () => installStreamToolView(ctx))
  ctx.slots.inject('main', () => {
    const stops = [ctx.slots.register({ name: 'main', key: PANEL_ID }, NodoEntry),
      ctx.slots.register({ name: 'main', key: 'nodo-workflow' }, WorkflowEntry)]
    return () => { for (const stop of stops) stop() }
  })
  ctx.slots.inject('main.conversation', createNativeWelcome(ctx, nativeSpace, NativeWelcome))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PANEL_ID, order: 1, label: 'Nodo',
  }, PanelIcon))
}

module.exports = { inject, apply }

import { PANEL_ID, setHostServices } from './ui-shared.js'
import { createNativeSpace } from './native-space.js'
import { createNativeWelcome } from './native-welcome.js'
import { createCompletionTracker } from './completion-tracker.js'
import { createModelSeat } from './model-seat.js'
import { createRoleSeat } from './role-seat.js'
import { createSessionReferences, REFERENCE_CSS } from './session-references.js'
import { createNewConversation } from './new-conversation.js'
import { NativeRunningDock } from './running.js'
import { CSS } from './styles.js'
import { SCROLLBAR_CSS, installScrollbars } from './scrollbars.ts'
import { NodoSidebar, NodoEntry, PanelIcon, NativeWelcome } from './page.js'
import { WorkflowEntry, WORKFLOW_CSS } from './workflow.js'
import { RolesEntry, ROLES_CSS } from './roles.tsx'

export const inject = ['slots', 'uiWorkspace', 'uiSession', 'sessions', 'layout', 'modelDirectories', 'remote', 'remote.session', 'commandUi', 'inputTriggers', 'conversation']

export function apply(ctx) {
  const space = createNativeSpace(ctx, NodoSidebar)
  createModelSeat(ctx, space)
  createRoleSeat(ctx, space)
  const { ReferenceDock, ReferenceDialog, installHistory } = createSessionReferences(ctx, space)
  const { NewConversation } = createNewConversation(ctx, space, ReferenceDialog)
  const completionTracker = createCompletionTracker({ getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) }, window)
  setHostServices({
    nativePickDirectory: typeof ctx.uiWorkspace?.pickDirectory === 'function' ? () => ctx.uiWorkspace.pickDirectory() : null,
    openNativeSession: id => space.open(id),
    nativeSpace: space,
    completionTracker,
    nativeSessionState: ctx.uiSession.adapter.current,
    NewConversation,
    layoutService: ctx.layout,
  })
  ctx.effect(() => () => completionTracker.dispose(), 'nodo: completion read state')
  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = CSS + REFERENCE_CSS + WORKFLOW_CSS + ROLES_CSS + SCROLLBAR_CSS
    document.head.appendChild(style)
    return () => style.remove()
  }, 'nodo: page styles')
  ctx.effect(() => {
    const root = document.documentElement
    const mark = () => root.toggleAttribute('data-nodo-space', space.getSnapshot().active)
    const stop = space.subscribe(mark)
    const dispose = installScrollbars(document)
    mark()
    return () => { stop(); dispose(); root.removeAttribute('data-nodo-space') }
  }, 'nodo: scrollbars')
  ctx.slots.inject('conversation.input.dock', () => {
    const stops = [
      ctx.slots.register({ name: 'conversation.input.dock', id: 'nodo-running', order: -100 }, NativeRunningDock),
      ctx.slots.register({ name: 'conversation.input.dock', id: 'nodo-references', order: -90 }, ReferenceDock),
    ]
    return () => { for (const stop of stops) stop() }
  })
  ctx.slots.inject('conversation.chat.node', installHistory)
  ctx.slots.inject('main', () => {
    const stops = [ctx.slots.register({ name: 'main', key: PANEL_ID }, NodoEntry),
      ctx.slots.register({ name: 'main', key: 'nodo-workflow' }, WorkflowEntry),
      ctx.slots.register({ name: 'main', key: 'nodo-roles' }, RolesEntry)]
    return () => { for (const stop of stops) stop() }
  })
  ctx.slots.inject('main.conversation', createNativeWelcome(ctx, space, NativeWelcome))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PANEL_ID, order: 1, label: 'Nodo',
  }, PanelIcon))
}

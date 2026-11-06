import { PANEL_ID, setHostServices } from './ui-shared.js'
import { createNativeSpace } from './native-space.js'
import { createRightPanel } from './right-panel.tsx'
import { createNativeWelcome } from './native-welcome.js'
import { createCompletionTracker } from './completion-tracker.js'
import { createModelSeat } from './model-seat.js'
import { createRoleSeat } from './role-seat.js'
import { createSessionReferences, REFERENCE_CSS } from './session-references.js'
import { createNewConversation } from './new-conversation.js'
import { NativeRunningDock } from './running.js'
import { CSS } from './styles.js'
import { SCROLLBAR_CSS, installScrollbars } from './scrollbars.ts'
import { NodoSidebar, NodoSidebarControl, NodoEntry, PanelIcon, NativeWelcome } from './page.js'
import { RolesEntry, ROLES_CSS } from './roles.tsx'

export const inject = ['slots', 'uiWorkspace', 'uiSession', 'sessions', 'layout', 'modelDirectories', 'remote', 'remote.session', 'commandUi', 'inputTriggers', 'conversation']

export function apply(ctx) {
  const space = createNativeSpace(ctx, NodoSidebar, NodoSidebarControl)
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
    rightPanelService: createRightPanel(ctx),
  })
  ctx.effect(() => () => completionTracker.dispose(), 'nodo: completion read state')
  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = CSS + REFERENCE_CSS + ROLES_CSS + SCROLLBAR_CSS
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
  // The Windows titlebar hosts the page's header row and panel toggles: the row
  // aligns with the main conversation card's left edge and ends ahead of the
  // native caption buttons, so both edges are measured — and once the sidebar
  // collapses, the row clears the host's own menu, whose right edge is measured
  // too. The card mounts a beat after each space publish, so the measurement
  // chases it over a few frames; the observer then follows it as the sidebar or
  // rightbar resize.
  ctx.effect(() => {
    const root = document.documentElement
    if (typeof document.querySelector !== 'function' || typeof root.style?.setProperty !== 'function') return () => {}
    const overlay = typeof navigator === 'undefined' ? null : navigator.windowControlsOverlay
    const caption = () => {
      const rect = overlay?.getTitlebarAreaRect?.()
      if (rect) root.style.setProperty('--nodo-caption-width', `${Math.max(0, root.clientWidth - rect.right)}px`)
    }
    const menu = () => {
      const host = document.querySelector('[data-windows-menu]')
      if (host) root.style.setProperty('--nodo-menu-end', `${Math.ceil(host.getBoundingClientRect().right)}px`)
    }
    const measure = () => {
      const main = document.querySelector('.nodo-main')
      if (main) root.style.setProperty('--nodo-main-left', `${Math.round(main.getBoundingClientRect().left)}px`)
      menu()
    }
    let observed = null
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
      const main = document.querySelector('.nodo-main')
      if (main !== observed) { if (observed) observer.unobserve(observed); if (main) observer.observe(main); observed = main }
      measure()
    }) : null
    let frame = 0, frames = 0
    const chase = () => {
      caption(); measure()
      const main = document.querySelector('.nodo-main')
      if (main && observer && main !== observed) { if (observed) observer.unobserve(observed); observer.observe(main); observed = main }
      if (!main && ++frames < 120) frame = requestAnimationFrame(chase)
    }
    const follow = () => { frames = 0; chase() }
    overlay?.addEventListener('geometrychange', caption)
    caption()
    const stopSpace = space.subscribe(follow)
    follow()
    return () => { stopSpace(); if (frame) cancelAnimationFrame(frame); overlay?.removeEventListener('geometrychange', caption); observer?.disconnect() }
  }, 'nodo: titlebar metrics')
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
      ctx.slots.register({ name: 'main', key: 'nodo-roles' }, RolesEntry)]
    return () => { for (const stop of stops) stop() }
  })
  ctx.slots.inject('main.conversation', createNativeWelcome(ctx, space, NativeWelcome))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PANEL_ID, order: 1, label: 'Nodo',
  }, PanelIcon))
}

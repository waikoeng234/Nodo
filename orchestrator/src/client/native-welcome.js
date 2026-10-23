// The Nodo space's own welcome page: only while the space is active and the
// current host session is still blank does it shadow main.conversation with the
// plugin's hero; the first sent message flips the summary's blank flag and the
// disposer hands the area back to the host's native conversation entry.
function createNativeWelcome(ctx, space, Welcome) {
  let release
  const update = () => {
    const state = space.getSnapshot()
    const id = ctx.uiSession.adapter.current.getSnapshot().key
    const show = state.active && !state.legacy && !state.drafting && ctx.sessions.list.getSnapshot().byId[id]?.blank === true
    if (show && !release) release = ctx.slots.register({ name: 'main.conversation', priority: -100 }, Welcome)
    else if (!show && release) { release(); release = null }
  }
  return () => {
    const stops = [space.subscribe(update), ctx.sessions.list.subscribe(update), ctx.uiSession.adapter.current.subscribe(update)]
    update()
    return () => { for (const stop of stops) stop(); release?.(); release = null }
  }
}

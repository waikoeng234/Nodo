import { createRemoteAccess } from '../../remote-access/index.js'

export function install(rt) {
  const service = createRemoteAccess({
    host: rt.ctx.get?.('webServer'),
    connection: rt.ctx.connection,
    preferences: () => rt.state.prefs.remoteAccess ?? {},
    save: async value => { rt.state.prefs.remoteAccess = value; await rt.saveStrict() },
  })
  const handle = rt.handle
  rt.handle = async (endpoint, payload) => {
    const method = ({ 'remote-status': 'status', 'remote-open': 'open', 'remote-enable': 'enable',
      'remote-disable': 'disable', 'remote-login': 'login' })[endpoint]
    if (!method) return handle(endpoint, payload)
    if (method !== 'status' && rt.readOnly()) return { ok: false, error: { code: 'orch/read-only', message: rt.readOnly() } }
    try { return { ok: true, value: await service[method]() } }
    catch (error) { return { ok: false, error: { code: 'orch/remote', message: error.message } } }
  }
  const load = rt.load
  let resumed = false
  rt.load = async () => {
    await load()
    if (resumed || rt.readOnly()) return
    resumed = true
    void service.resume().catch(() => {})
  }
  rt.ctx.effect(() => () => service.close(), 'nodo: remote access')
}

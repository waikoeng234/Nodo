import { createRemoteAccess } from '../../remote-access/index.js'

export function install(rt) {
  const service = createRemoteAccess({
    host: typeof rt.ctx.get === 'function' ? rt.ctx.get('webServer') : rt.ctx.webServer,
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
  rt.load = async () => {
    await load()
    if (!rt.readOnly()) void service.resume().catch(() => {})
  }
  rt.ctx.effect(() => () => service.close(), 'nodo: remote access')
}

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { command } from './command.js'
import { startMobileProxy } from './proxy.js'

const TAILSCALE = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
const message = (phase, reason, extra = {}) => ({ phase, reason, ...extra })

export function createRemoteAccess({ host, connection, preferences, save, platform = process.platform,
  exists = existsSync, run = command, proxy = startMobileProxy }) {
  let stop, port, busy = false, closed = false
  const state = () => ({ enabled: preferences().enabled === true, busy })
  // Preferences saved before ports were persisted forwarded to the former fixed port.
  const persisted = () => { const { port } = preferences(); return Number.isInteger(port) && port > 0 && port < 65536 ? port : 43819 }
  const target = () => state().enabled ? `http://127.0.0.1:${persisted()}` : ''
  const retract = async () => {
    const origin = preferences().origin
    if (!origin || !URL.canParse(origin) || !exists(TAILSCALE)) return true
    let config
    try { config = JSON.parse(String((await run(TAILSCALE, ['serve', 'status', '--json'])).stdout)) } catch { return false }
    if (config.Web?.[`${new URL(origin).host}:443`]?.Handlers?.['/']?.Proxy !== target()) return true
    return (await run(TAILSCALE, ['serve', '--yes', '--https=443', '--set-path=/', 'off'])).code === 0
  }
  const inspect = async () => {
    if (platform !== 'darwin' || !host?.getOrigin || !connection?.authenticatedUrl)
      return message('unsupported', '目前支持 macOS 上的 DSH Desktop。')
    if (!exists('/usr/sbin/httpd')) return message('unsupported', '系统缺少远程访问所需的 Apache。')
    if (!exists(TAILSCALE)) return message('install', '请先在电脑和手机安装 Tailscale，并登录同一账号。')
    const result = await run(TAILSCALE, ['status', '--json'])
    let status
    try { status = JSON.parse(String(result.stdout)) } catch { return message('unavailable', '无法连接 Tailscale，请打开它后重新检查。') }
    if (result.code !== 0) return message('unavailable', '无法连接 Tailscale，请打开它后重新检查。')
    if (status.BackendState !== 'Running') return message('connect', '请在 Tailscale 中登录并连接。')
    if (status.Health?.some(value => value.includes('ReceiveIPv4')))
      return message('network', 'Tailscale 收包模块异常，请完全退出并重新打开 Tailscale。')
    const hostname = String(status.Self?.DNSName ?? '').replace(/\.$/, '').toLowerCase()
    if (!/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(hostname))
      return message('connect', '尚未取得私有域名，请确认 Tailscale 已连接。')
    const origin = `https://${hostname}`
    const serve = await run(TAILSCALE, ['serve', 'status', '--json'])
    let config
    try { config = JSON.parse(String(serve.stdout)) } catch { return message('unavailable', '无法读取 Tailscale Serve 状态，请重新检查。') }
    if (serve.code !== 0) return message('unavailable', '无法读取 Tailscale Serve 状态，请重新检查。')
    const key = `${hostname}:443`
    const handler = config.Web?.[key]?.Handlers?.['/']
    if (config.AllowFunnel?.[key]) return message('conflict', '此地址已开启公网 Funnel，请先关闭它；手机远程只使用私有网络。')
    if ((handler && handler.Proxy !== target()) || (config.TCP?.['443'] && !config.TCP['443'].HTTPS))
      return message('conflict', '此 HTTPS 入口已用于其他服务，现有配置保持不变。')
    return { phase: 'ready', origin, configured: handler?.Proxy === target() }
  }
  const status = async () => {
    const view = await inspect()
    const enabled = state().enabled
    return { ...view, ...state(), phase: view.phase === 'ready' ? enabled && view.configured && stop ? 'enabled' : 'ready' : view.phase,
      reason: view.reason || (enabled && !view.configured ? '转发已停止，可重新启用。'
        : enabled && !stop ? '本机代理未运行，可重新启用。' : '') }
  }
  const release = async () => { const dispose = stop; stop = undefined; await dispose?.() }
  const start = async (origin, reuse) => {
    if (closed) throw new Error('远程访问已停止，请重新打开设置。')
    if (!stop) ({ stop, port } = await proxy(host.getOrigin(), origin, reuse))
  }
  return {
    status,
    async open() {
      if (platform !== 'darwin') throw new Error('当前平台暂不支持。')
      const result = await run('/usr/bin/open', exists(TAILSCALE) ? ['-a', 'Tailscale'] : ['https://tailscale.com/download/mac'])
      if (result.code !== 0) throw new Error('无法自动打开，请手动打开 Tailscale 后重新检查。')
    },
    async enable() {
      if (busy) throw new Error('正在配置远程访问，请稍后。')
      busy = true
      let created = false, origin, view
      try {
        view = await inspect()
        if (view.phase !== 'ready') return { ...view, ...state(), busy: false }
        origin = view.origin
        await start(origin, view.configured ? persisted() : undefined)
        if (!view.configured) {
          const result = await run(TAILSCALE, ['serve', '--bg', '--yes', '--https=443', '--set-path=/', `http://127.0.0.1:${port}`], { timeout: 8_000 })
          if (result.code !== 0) {
            const url = /https:\/\/login\.tailscale\.com\/f\/serve\?node=[\w-]+/.exec(`${result.stdout}\n${result.stderr}`)?.[0]
            await release()
            if (url) return { ...state(), busy: false, phase: 'authorize', authorizationUrl: url,
              reason: '请授权 HTTPS certificates，保持可选的 Tailscale Funnel 关闭，然后继续配置。' }
            throw new Error('无法启用 Tailscale Serve，请检查 Tailscale 连接后重试。')
          }
          created = true
        }
        await save({ enabled: true, origin, port })
        return { enabled: true, busy: false, phase: 'enabled', origin, configured: true }
      } catch (error) {
        await release()
        if (created) await run(TAILSCALE, ['serve', '--yes', '--https=443', '--set-path=/', 'off'])
        else if (view?.configured) await retract()
        throw error
      } finally { busy = false }
    },
    async disable() {
      if (busy) throw new Error('正在配置远程访问，请稍后。')
      busy = true
      try {
        if (!await retract()) throw new Error('转发尚未移除，请打开 Tailscale 后重试关闭。')
        await release()
        await save({ enabled: false })
        return { enabled: false, busy: false, phase: 'ready' }
      } finally { busy = false }
    },
    async login() {
      const view = await status()
      if (view.phase !== 'enabled') throw new Error('请先启用手机远程访问。')
      const url = connection.authenticatedUrl(view.origin)
      const result = await run('/usr/bin/osascript', ['-l', 'JavaScript', fileURLToPath(new URL('./qr-code.jxa', import.meta.url))], { input: url })
      if (result.code !== 0 || !Buffer.from(result.stdout).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
        throw new Error('二维码生成失败，请重新连接手机。')
      return { url, origin: view.origin, qr: `data:image/png;base64,${Buffer.from(result.stdout).toString('base64')}` }
    },
    async resume() {
      if (!state().enabled) return
      const view = await inspect()
      if (view.phase === 'ready' && view.configured) await start(view.origin, persisted()).catch(() => {})
      if (!stop) await retract()
    },
    async close() { closed = true; await release() },
  }
}

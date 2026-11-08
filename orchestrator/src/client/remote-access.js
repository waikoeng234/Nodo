import { h, useEffect, useState, call, Button, StateDot, writeClipboard } from './ui-shared.js'

export function RemoteAccessSettings({ readOnly = false }) {
  const [view, setView] = useState(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [login, setLogin] = useState(null)
  const [copied, setCopied] = useState(false)
  const act = async (action = 'status') => {
    setBusy(action); setError(''); setLogin(null); setCopied(false)
    try {
      const result = await call(`remote-${action}`)
      if (action === 'login') setLogin(result)
      else if (action !== 'open') setView(result)
    } catch (failure) { setError(failure.message) }
    finally { setBusy('') }
  }
  useEffect(() => {
    let active = true
    call('remote-status').then(value => { if (active) setView(value) })
      .catch(failure => { if (active) setError(failure.message) })
    return () => { active = false }
  }, [])
  const locked = !!busy || !!view?.busy || readOnly
  const enabled = view?.phase === 'enabled'
  const labels = {
    unsupported: '当前环境暂不支持', install: '安装 Tailscale', unavailable: '打开 Tailscale',
    connect: '连接 Tailscale', network: '网络需要处理', conflict: '入口需要处理',
    authorize: '授权 HTTPS', ready: '准备就绪', enabled: '手机远程已启用',
  }
  return h('section', { className: 'nodo-remote', 'aria-label': '手机远程' },
    h('div', { className: 'nodo-remote-heading' },
      h('h3', null, '手机远程'),
      h(Button, { variant: 'ghost', size: 'sm', disabled: !!busy, onClick: () => void act() }, busy === 'status' ? '检查中…' : '重新检查')),
    !view && !error && h('p', { className: 'nodo-dialog-hint', role: 'status' }, '正在检查 Desktop 与 Tailscale…'),
    view && h('div', { className: 'nodo-remote-status', role: 'status', 'aria-live': 'polite' },
      h('div', { className: 'nodo-remote-status-title' },
        h(StateDot, { state: enabled ? 'done' : ['network', 'conflict', 'unavailable'].includes(view.phase) ? 'error' : 'idle', size: 8 }),
        h('strong', null, labels[view.phase] ?? '检查连接')),
      view.reason && h('p', null, view.reason),
      view.origin && h('p', { className: 'nodo-remote-address' }, view.origin)),
    h('div', { className: 'nodo-remote-actions' },
      view && ['install', 'unavailable', 'connect', 'network'].includes(view.phase)
        && h(Button, { variant: 'primary', disabled: locked, onClick: () => void act('open') }, view.phase === 'install' ? '安装 Tailscale' : '打开 Tailscale'),
      view?.phase === 'authorize' && h('a', { href: view.authorizationUrl, target: '_blank', rel: 'noopener noreferrer', className: 'nodo-remote-link' }, '打开 HTTPS 授权页'),
      view && ['ready', 'authorize'].includes(view.phase) && h(Button, { variant: 'primary', disabled: locked, onClick: () => void act('enable') },
        busy === 'enable' ? '配置中…' : view.phase === 'authorize' ? '已授权，继续配置' : '启用手机远程'),
      enabled && h(Button, { variant: 'primary', disabled: locked, onClick: () => void act('login') }, busy === 'login' ? '生成中…' : login ? '刷新二维码' : '连接手机'),
      view?.enabled && h(Button, { variant: 'outline', disabled: locked, onClick: () => void act('disable') }, busy === 'disable' ? '关闭中…' : '关闭远程访问')),
    login && h('div', { className: 'nodo-remote-pair' },
      h('div', { className: 'nodo-remote-qr' }, h('img', { src: login.qr, alt: '手机登录二维码', width: 192, height: 192 })),
      h('div', { className: 'nodo-remote-pair-copy' },
        h(Button, { variant: 'outline', disabled: locked, onClick: async () => {
          try {
            if (await writeClipboard(login.url)) setCopied(true)
            else setError('复制失败，请重试。')
          } catch { setError('复制失败，请重试。') }
        } }, copied ? '已复制' : '复制手机登录链接'),
        h('p', { className: 'nodo-dialog-hint' }, '二维码授予当前 DSH 宿主的所有者访问权限，请勿分享。'))),
    error && h('p', { className: 'nodo-dialog-error', role: 'alert' }, error),
    readOnly && h('p', { className: 'nodo-dialog-hint' }, '当前宿主为只读模式，请在正在运行任务的 Desktop 中设置。'))
}

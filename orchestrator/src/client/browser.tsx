import {
  h, useEffect, useRef, useState, Button,
  IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular, IconRefreshOutlineRegular,
} from './ui-shared.js'

type Reservation = { lease: string; partition: string }
type BrowserBridge = {
  acquire: (workspace: string) => Promise<Reservation>
  release: (lease: string) => Promise<void>
  onOpenRequested: (lease: string, listener: (url: string) => void) => () => void
}
type Webview = HTMLElement & {
  loadURL: (url: string) => Promise<void>
  getURL: () => string
  getTitle: () => string
  canGoBack: () => boolean
  canGoForward: () => boolean
  goBack: () => void
  goForward: () => void
  reload: () => void
  clearHistory: () => void
}
const desktopBrowser = () => (globalThis as typeof globalThis & { dshDesktop?: { browser?: BrowserBridge } }).dshDesktop?.browser

export function normalizeBrowserAddress(input: string): string | null {
  let address = input.trim()
  if (!address || address.length > 16384 || /[\s\\]/.test(address)) return null
  if (/^:?\d+$/.test(address)) address = `http://localhost:${address.replace(/^:/, '')}`
  else if (/^(localhost|127(?:\.\d{1,3}){1,3}|\[[^\]]+\])(?=[:/?#]|$)/i.test(address)) address = `http://${address}`
  else if (!/^[a-z][a-z\d+.-]*:/i.test(address) || /^[a-z\d.-]+\.[a-z\d-]+:\d+(?=[/?#]|$)/i.test(address)) address = `https://${address}`
  try {
    const url = new URL(address)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.port === '0') return null
    const origin = (globalThis as typeof globalThis & { location?: { origin?: string } }).location?.origin
    if (origin && origin !== 'null' && url.origin === origin) return null
    return url.href
  } catch { return null }
}

export const browserTitle = (url: string) => url ? new URL(url).hostname : '浏览器'

export function BrowserView({ cwd, initialUrl, onChange, onOpen }: {
  cwd?: string; initialUrl: string; onChange: (url: string, title: string) => void; onOpen: (url: string) => void
}) {
  const [bridge] = useState(desktopBrowser)
  const [address, setAddress] = useState(initialUrl)
  const [url, setUrl] = useState(initialUrl)
  const [error, setError] = useState('')
  const [navigation, setNavigation] = useState({ back: false, forward: false })
  const [revision, setRevision] = useState(0)
  const viewport = useRef<HTMLDivElement | null>(null)
  const commands = useRef<{ navigate: (url: string) => void; back: () => void; forward: () => void; reload: () => void } | null>(null)
  const latestUrl = useRef(initialUrl)
  latestUrl.current = initialUrl
  const callbacks = useRef({ onChange, onOpen })
  callbacks.current = { onChange, onOpen }
  useEffect(() => {
    if (!bridge) return
    if (!cwd) { setError('工作区不可用'); return }
    let live = true, ready = false, firstDocument = true, loadRevision = 0
    let pending = latestUrl.current, observed = latestUrl.current
    let guest: Webview | undefined, lease: string | undefined, unsubscribe: (() => void) | undefined
    const dispose = () => {
      unsubscribe?.()
      unsubscribe = undefined
      commands.current = null
      guest?.remove()
      guest = undefined
      if (lease) { void bridge.release(lease).catch(() => {}); lease = undefined }
    }
    const load = (value: string) => {
      pending = value
      if (!ready || !guest) return
      pending = ''
      const current = ++loadRevision
      void guest.loadURL(value).catch(failure => {
        if (live && current === loadRevision && !(typeof failure === 'object' && failure !== null && 'code' in failure && failure.code === 'ERR_ABORTED')) setError('网页加载失败')
      })
    }
    const observe = () => {
      if (!live || !ready || !guest) return
      try {
        const current = normalizeBrowserAddress(guest.getURL())
        if (!current) return
        setError('')
        if (firstDocument) { guest.clearHistory(); firstDocument = false }
        if (current !== observed) { observed = current; setAddress(current); setUrl(current) }
        const title = guest.getTitle().trim()
        if (title) guest.setAttribute('aria-label', title)
        callbacks.current.onChange(current, title || browserTitle(current))
        setNavigation({ back: guest.canGoBack(), forward: guest.canGoForward() })
      } catch { setError('无法读取网页状态') }
    }
    commands.current = { navigate: load, back: () => guest?.goBack(), forward: () => guest?.goForward(), reload: () => guest?.reload() }
    void (async () => {
      const reservation = await bridge.acquire(`cwd:${cwd}`)
      if (!live) { await bridge.release(reservation.lease); return }
      lease = reservation.lease
      setError('')
      const element = document.createElement('webview') as Webview
      guest = element
      element.className = 'nodo-browser-frame'
      element.setAttribute('name', reservation.lease)
      element.setAttribute('partition', reservation.partition)
      element.setAttribute('allowpopups', '')
      element.setAttribute('src', `about:blank#${reservation.lease}`)
      element.setAttribute('aria-label', '浏览器页面')
      unsubscribe = bridge.onOpenRequested(reservation.lease, value => {
        const next = normalizeBrowserAddress(value)
        if (live && next) callbacks.current.onOpen(next)
      })
      element.addEventListener('dom-ready', () => { if (live) { ready = true; setError(''); observe(); if (pending) load(pending) } })
      for (const event of ['did-navigate', 'did-navigate-in-page', 'did-stop-loading', 'page-title-updated']) element.addEventListener(event, observe)
      element.addEventListener('did-fail-load', event => {
        const failure = event as Event & { isMainFrame?: boolean; errorCode?: number }
        if (live && failure.isMainFrame && failure.errorCode !== -3) setError('网页加载失败')
      })
      viewport.current?.appendChild(element)
    })().catch(() => { if (live) { dispose(); setError('无法打开浏览器') } })
    return () => { live = false; dispose() }
  }, [bridge, cwd])

  const navigate = () => {
    const next = normalizeBrowserAddress(address)
    if (!next) { setError('仅支持 HTTP 或 HTTPS 地址'); return }
    setError('')
    setAddress(next)
    setUrl(next)
    callbacks.current.onChange(next, browserTitle(next))
    commands.current?.navigate(next)
  }
  const command = (action: 'back' | 'forward' | 'reload') => {
    setError('')
    try {
      if (bridge) commands.current?.[action]()
      else if (action === 'reload') setRevision(value => value + 1)
    } catch { setError('网页操作失败') }
  }
  return <div className="nodo-browser">
    <div className="nodo-browser-toolbar">
      <Button variant="ghost" aria-label="后退" disabled={!navigation.back} onClick={() => command('back')} icon={<IconChevronLeftOutlineRegular size={16} />} />
      <Button variant="ghost" aria-label="前进" disabled={!navigation.forward} onClick={() => command('forward')} icon={<IconChevronRightOutlineRegular size={16} />} />
      <Button variant="ghost" aria-label="刷新网页" disabled={!url} onClick={() => command('reload')} icon={<IconRefreshOutlineRegular size={16} />} />
      <form onSubmit={event => { event.preventDefault(); navigate() }}>
        <input aria-label="网页地址" placeholder="输入网址或端口" value={address} onChange={event => setAddress(event.currentTarget.value)}
          autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      </form>
      {!bridge && <Button variant="ghost" disabled={!url} onClick={() => globalThis.open(url, '_blank', 'noopener,noreferrer')}>在外部打开</Button>}
    </div>
    {error && <p className="nodo-right-status" role="status">{error}</p>}
    <div className="nodo-browser-viewport" ref={viewport}>
      {!bridge && <iframe key={revision} className="nodo-browser-frame" title="浏览器页面" src={url || 'about:blank'} referrerPolicy="no-referrer"
        sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox" />}
    </div>
  </div>
}

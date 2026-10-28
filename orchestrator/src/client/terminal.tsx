import { h, useEffect, useLayoutEffect, useRef, useState } from './ui-shared.js'

export type TerminalTarget = { profile: string; session: string }
export type TerminalSize = { cols: number; rows: number }
export type TerminalRecord = { id: string; cols?: number; rows?: number; shell?: string; exited?: { code: number | null; signal?: string | null; failed?: boolean } }
export type TerminalList = { available: boolean; terminals: TerminalRecord[] }
const ROUTE = '/api/nodo/terminal'
export class TerminalMissingError extends Error {}

export async function terminalRequest(op: string, payload: object = {}) {
  const response = await fetch(ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, ...payload }) })
  const answer = await response.json()
  if (response.status === 404 || answer.error?.code === 'terminal/not-found') throw new TerminalMissingError('终端不存在')
  if (!answer.ok) throw new Error('终端操作失败')
  return answer.value
}

const sizeOf = ({ cols, rows }: TerminalSize) => ({ cols: Math.max(2, Math.min(32767, cols)), rows: Math.max(1, Math.min(32767, rows)) })
async function openTerminal(element: HTMLElement, size?: TerminalSize) {
  const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')])
  const terminal = new Terminal({ cursorBlink: true, fontSize: 13, scrollback: 3000, minimumContrastRatio: 4.5, ...size })
  const fit = new FitAddon()
  try { terminal.loadAddon(fit); terminal.open(element) }
  catch (error) { terminal.dispose(); throw error }
  return { terminal, fit }
}

export async function measureTerminal(element: HTMLElement | null): Promise<TerminalSize> {
  if (!element || !element.clientWidth || !element.clientHeight) throw new Error('Terminal is hidden')
  const screen = document.createElement('div')
  screen.className = 'nodo-terminal'
  screen.style.cssText = 'position:absolute;inset:0;visibility:hidden;pointer-events:none'
  element.appendChild(screen)
  let view
  try {
    view = await openTerminal(screen)
    const size = view.fit.proposeDimensions()
    if (!size) throw new Error('Terminal dimensions unavailable')
    return sizeOf(size)
  } finally { view?.terminal.dispose(); screen.remove() }
}

type Frame = { type: string; from?: number; seq: number; data?: string; code?: number | null; signal?: string | null; failed?: boolean }

export function TerminalView({ id, target, initialSize, active, onGone }: { id: string; target: TerminalTarget; initialSize?: TerminalSize; active: boolean; onGone: () => void }) {
  const container = useRef<HTMLDivElement | null>(null)
  const resize = useRef<() => void>(() => {})
  const [message, setMessage] = useState('')
  const gone = useRef(onGone)
  gone.current = onGone
  useLayoutEffect(() => {
    const element = container.current
    if (!element) return
    let live = true, cleanup = () => {}
    void openTerminal(element, initialSize).then(({ terminal, fit }) => {
      if (!live) { terminal.dispose(); return }
      const scope = { profile: target.profile, session: target.session }
      let exited = false, seq = 0, writing = Promise.resolve()
      let frame: number | undefined, retry: ReturnType<typeof setTimeout> | undefined, resizing = false, resizeFailures = 0
      let applied = initialSize, desired: TerminalSize | undefined
      const abort = new AbortController()
      const missing = (error: unknown) => {
        if (!(error instanceof TerminalMissingError)) return false
        exited = true; gone.current(); return true
      }
      const updateTheme = () => {
        const style = getComputedStyle(element)
        const color = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
        terminal.options.theme = {
          background: color('--dsw-alias-bg-base', '#171717'), foreground: color('--dsw-alias-label-primary', '#eeeeee'),
          cursor: color('--dsw-alias-label-primary', '#eeeeee'), selectionBackground: color('--dsw-alias-interactive-bg-active', '#77777766'),
        }
      }
      const syncSize = async () => {
        if (resizing || !desired || applied?.cols === desired.cols && applied?.rows === desired.rows) return
        const size = desired
        resizing = true
        try {
          await terminalRequest('resize', { ...scope, id, ...size })
          if (!live) return
          applied = size; resizeFailures = 0
          terminal.resize(size.cols, size.rows)
          setMessage(current => current === '尺寸同步失败，正在重试…' ? '' : current)
        } catch (error) {
          if (live && !missing(error)) {
            setMessage('尺寸同步失败，正在重试…')
            retry = setTimeout(() => { retry = undefined; resize.current() }, Math.min(1000 * 2 ** resizeFailures++, 8000))
          }
        } finally {
          resizing = false
          if (live && !exited && !retry && (applied?.cols !== desired?.cols || applied?.rows !== desired?.rows)) resize.current()
        }
      }
      resize.current = () => {
        if (frame !== undefined || !live || exited) return
        frame = requestAnimationFrame(() => {
          frame = undefined
          if (!live || exited || !element.clientWidth || !element.clientHeight) return
          updateTheme()
          const size = fit.proposeDimensions()
          if (size) { desired = sizeOf(size); if (!retry) void syncSize() }
        })
      }
      const observer = new ResizeObserver(() => resize.current())
      observer.observe(element)
      const theme = new MutationObserver(updateTheme)
      theme.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-color-scheme'] })
      updateTheme()
      resize.current()
      const input = terminal.onData(data => {
        writing = writing.then(async () => {
          for (let start = 0; live && !exited && start < data.length;) {
            let end = Math.min(start + 256 * 1024, data.length)
            const last = data.charCodeAt(end - 1)
            if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--
            await terminalRequest('write', { ...scope, id, data: data.slice(start, end) })
            start = end
          }
        }).catch(error => { if (live && !missing(error)) setMessage('输入失败') })
      })
      const apply = async (frame: Frame) => {
        if (frame.type === 'reset') { terminal.reset(); seq = frame.seq }
        else if (frame.type === 'output' && frame.data && frame.seq > seq) {
          const bytes = Uint8Array.from(atob(frame.data), character => character.charCodeAt(0))
          await new Promise<void>(resolve => terminal.write(bytes.subarray(Math.max(0, seq - (frame.from ?? seq))), resolve))
          seq = frame.seq
        } else if (frame.type === 'exit') {
          exited = true
          setMessage(frame.failed ? '终端已中断' : `已退出${frame.code == null ? '' : ` (${frame.code})`}`)
        }
      }
      const connect = async () => {
        let failures = 0
        while (live && !exited) {
          const before = seq
          try {
            const query = new URLSearchParams({ ...scope, id, since: String(seq) })
            const response = await fetch(`${ROUTE}?${query}`, { signal: abort.signal })
            if (!live) return
            if (response.status === 404) { exited = true; gone.current(); return }
            if (!response.ok || !response.body) throw new Error('Stream unavailable')
            setMessage('')
            const reader = response.body.getReader(), decoder = new TextDecoder()
            let pending = ''
            try {
              while (live) {
                const { value, done } = await reader.read()
                if (done) break
                pending += decoder.decode(value, { stream: true })
                let newline
                while ((newline = pending.indexOf('\n')) >= 0) {
                  const line = pending.slice(0, newline)
                  pending = pending.slice(newline + 1)
                  if (live && line) await apply(JSON.parse(line))
                }
              }
            } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
          } catch { if (live) setMessage('连接中断，正在重连…') }
          if (seq > before) failures = 0
          if (live && !exited && ++failures > 5) { setMessage('连接已中断'); break }
          if (live && !exited) await new Promise<void>(resolve => {
            const done = () => { clearTimeout(timer); abort.signal.removeEventListener('abort', done); resolve() }
            const timer = setTimeout(done, 1000 * 2 ** (failures - 1))
            abort.signal.addEventListener('abort', done, { once: true })
            if (abort.signal.aborted) done()
          })
        }
      }
      void connect()
      cleanup = () => {
        live = false; abort.abort(); observer.disconnect(); theme.disconnect(); input.dispose(); terminal.dispose()
        if (frame !== undefined) cancelAnimationFrame(frame)
        clearTimeout(retry)
        resize.current = () => {}
      }
    }).catch(() => { if (live) setMessage('终端不可用') })
    return () => { live = false; cleanup() }
  }, [id, target.profile, target.session])
  useEffect(() => { if (active) resize.current() }, [active])
  return <div className="nodo-terminal">
    <div className="nodo-terminal-screen" ref={container} />
    {message && <p className="nodo-right-status" role="status">{message}</p>}
  </div>
}

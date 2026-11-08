import { h, useEffect, useLayoutEffect, useId, useMemo, useRef, useState, useSyncExternalStore, call, rightPanelService, MarkdownText, MarkdownDelegateProvider, useMarkdownDelegate } from './ui-shared.js'
import type { MARKDOWN_LABELS } from './ui-shared.js'
import { terminalScope } from './terminal.tsx'
import { relativeFile } from './file-diffs.ts'

interface TextPart { node: Text; start: number; end: number }
interface ActiveWord { start: number; end: number; text: string; since: number; name: string; ink: string }
interface DecorationOptions { name: string; streaming: boolean; animate?: boolean }
interface StreamingDecoration { update: (streaming: boolean, animate?: boolean) => void; dispose: () => void }
export interface StreamingTextProps {
  text: string
  streaming?: boolean
  animate?: boolean
  labels?: typeof MARKDOWN_LABELS
  variant?: string
  fileLinks?: boolean
}

const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('zh-CN', { granularity: 'word' }) : null
const FADE_MS = 260
const STAGGER_MS = 160
const ignored = 'button:not([data-nodo-file]),svg,style,script,[aria-hidden="true"],[hidden]'
const blocks = 'p,li,pre,blockquote,h1,h2,h3,h4,h5,h6,td,th'

export function streamingWords(root: HTMLElement): { nodes: TextPart[]; words: Intl.SegmentData[]; text: string } {
  const nodes: TextPart[] = []
  const walker = root.ownerDocument.createTreeWalker(root, 4)
  let text = ''
  let block: Element | null = null
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    const node = current as Text
    const parent = node.parentElement
    if (!parent || parent.closest(ignored)) continue
    const nextBlock = parent.closest(blocks)
    if (nodes.length && block !== nextBlock) text += '\n'
    block = nextBlock
    nodes.push({ node, start: text.length, end: text.length + node.data.length })
    text += node.data
  }
  return { nodes, words: segmenter ? [...segmenter.segment(text)].filter(word => word.isWordLike) : [], text }
}

function textRange(document: Document, nodes: TextPart[], start: number, end: number): Range | null {
  const parts = nodes.filter(part => part.start < end && part.end > start)
  const first = parts[0], last = parts.at(-1)
  if (!first || !last) return null
  const range = document.createRange()
  range.setStart(first.node, Math.max(0, start - first.start))
  range.setEnd(last.node, Math.min(last.node.data.length, end - last.start))
  return range
}

// Highlight ranges leave the host's Markdown DOM and React's text nodes intact.
export function decorateStreamingText(root: HTMLElement, caret: HTMLElement, { name, streaming, animate = streaming }: DecorationOptions): StreamingDecoration {
  const document = root.ownerDocument
  const view = document.defaultView
  if (!view) return { update() {}, dispose() {} }
  const highlights = view.CSS?.highlights
  const canHighlight = highlights && typeof view.Highlight === 'function' && segmenter
  const reducedMotion = view.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  let palette: HTMLStyleElement | null = null
  const active = new Map<string, ActiveWord>()
  let previous = ''
  let animated = animate || streaming
  let nodes: TextPart[] = []
  let frame = 0
  const positionCaret = () => {
    caret.hidden = true
    const last = nodes.filter(part => part.node.data.trim() !== '').at(-1)
    if (!streaming || !last || !root.parentElement) return
    const range = document.createRange()
    range.setStart(last.node, last.node.data.trimEnd().length)
    range.collapse(true)
    const rect = range.getBoundingClientRect()
    if (!rect.height) return
    const box = root.parentElement.getBoundingClientRect()
    Object.assign(caret.style, { left: `${rect.left - box.left}px`, top: `${rect.top - box.top}px`, height: `${rect.height}px` })
    caret.hidden = false
  }
  const draw = () => {
    frame = 0
    const now = view.performance.now()
    const rules = []
    for (const [key, item] of active) {
      const progress = Math.max(0, Math.min(1, (now - item.since) / FADE_MS))
      if (progress === 1) {
        highlights?.delete(item.name)
        active.delete(key)
        continue
      }
      const opacity = 1 - (1 - progress) ** 3
      rules.push(`::highlight(${item.name}){color:color-mix(in srgb,${item.ink} ${opacity * 100}%,transparent)}`)
    }
    if (rules.length) {
      if (!palette) { palette = document.createElement('style'); document.head.appendChild(palette) }
      palette.textContent = rules.join('\n')
      frame = view.requestAnimationFrame(draw)
    } else { palette?.remove(); palette = null }
  }
  const update = () => {
    if (frame) view.cancelAnimationFrame(frame)
    frame = 0
    const parsed = streamingWords(root)
    nodes = parsed.nodes
    positionCaret()
    const now = view.performance.now()
    let prefix = 0
    for (const letter of parsed.text) {
      if (previous.slice(prefix, prefix + letter.length) !== letter) break
      prefix += letter.length
    }
    for (const [key, item] of active) {
      if (parsed.text.slice(item.start, item.end) !== item.text) { highlights?.delete(item.name); active.delete(key) }
    }
    if (canHighlight && !reducedMotion && animated && prefix < parsed.text.length) {
      const starts = [0, ...parsed.words.slice(1).map(word => word.index)]
      const fresh = starts.map((start, index) => ({ start: Math.max(prefix, start), end: starts[index + 1] ?? parsed.text.length }))
        .filter(part => part.start < part.end && parsed.text.slice(part.start, part.end).trim() !== '')
      fresh.forEach((part, index) => {
        const key = `${part.start}-${part.end}`
        active.set(key, { ...part, text: parsed.text.slice(part.start, part.end), ink: '', name: `${name}-${key}`,
          since: now + index / Math.max(1, fresh.length - 1) * Math.min(STAGGER_MS, fresh.length * 12) })
      })
    }
    previous = parsed.text
    for (const [key, item] of active) {
      const range = textRange(document, nodes, item.start, item.end)
      const parent = range?.startContainer.parentElement
      if (!range || !parent || !highlights) { highlights?.delete(item.name); active.delete(key); continue }
      item.ink = view.getComputedStyle(parent).color
      highlights.set(item.name, new view.Highlight(range))
    }
    draw()
  }
  update()
  const mutation = typeof view.MutationObserver === 'function' ? new view.MutationObserver(update) : null
  mutation?.observe(root, { subtree: true, childList: true, characterData: true })
  const resize = typeof view.ResizeObserver === 'function' ? new view.ResizeObserver(positionCaret) : null
  resize?.observe(root)
  return {
    update(nextStreaming, nextAnimate = nextStreaming) { streaming = nextStreaming; animated ||= nextAnimate || nextStreaming; update() },
    dispose() {
      if (frame) view.cancelAnimationFrame(frame)
      mutation?.disconnect()
      resize?.disconnect()
      for (const item of active.values()) highlights?.delete(item.name)
      active.clear()
      palette?.remove()
      caret.hidden = true
    },
  }
}

// 只有 workspace-file 能读出文本或图片的路径才成为链接；裸文件名在根目录读不到时按文件名在工作区里找，唯一匹配才算。
// 只全局缓存命中（值为解析后的路径），未命中或失败只在本条消息内不再重复请求。
const foundFiles = new Map<string, string>()
const pendingFiles = new Set<string>()
const fileListeners = new Set<(key: string) => void>()
const LINKED_FILE = { 'data-nodo-file': '' }
const PLAIN_FILE = { ...LINKED_FILE, className: 'nodo-file-plain', disabled: true, title: undefined }
const unsubscribed = () => () => {}
// 与 core/src/workspaces.js 的 FILES_MATCH_MAX 一致；返回满额说明结果可能被截断，无法确认唯一。
const FILES_MATCH_MAX = 30

export const codeFilePath = (text: string): string | undefined => {
  const path = text.trim().replace(/(?:#L\d+(?:-L?\d+)?|:\d+(?::\d+)?(?:-\d+(?::\d+)?)?)$/, '')
  const nested = path.includes('/')
  return /^[^\t\r\n~'"`<>|*?{}]+$/.test(path) && (nested || !path.includes(' ')) && !path.includes('://') && !path.endsWith('/')
    && (nested || /\.[a-z][\w-]*$/i.test(path) || /^(?:[A-Z][a-z]+|[A-Z][A-Z\d_]+)$/.test(path)) ? path : undefined
}

function useFileLinks() {
  const target = useSyncExternalStore(rightPanelService?.subscribe ?? unsubscribed, () => rightPanelService?.getSnapshot().target ?? null)
  const outer = useMarkdownDelegate()
  const asked = useRef(new Set<string>())
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const listener = (key: string) => { if (asked.current.has(key)) setVersion(value => value + 1) }
    fileListeners.add(listener)
    return () => { fileListeners.delete(listener) }
  }, [])
  return useMemo(() => {
    if (!target) return null
    const scope = terminalScope(target)
    const keyOf = (path: string) => JSON.stringify([scope, target.cwd, path])
    const readable = (path: string) => call('workspace-file', { ...scope, path }).then((value: { text?: string; image?: unknown }) => typeof value.text === 'string' || !!value.image, () => false)
    const locate = (path: string): string | undefined => {
      const key = keyOf(path)
      const found = foundFiles.get(key)
      if (found !== undefined) return found
      if (!asked.current.has(key) && !pendingFiles.has(key)) {
        pendingFiles.add(key)
        void readable(path).then(found => found ? path : path.includes('/') ? undefined
          : call('workspace-files', { ...scope, query: path }).then(({ files }: { files: string[] }) => {
            const matches = files.filter(file => file.endsWith(`/${path}`))
            return matches.length === 1 && files.length < FILES_MATCH_MAX ? readable(matches[0]).then(found => found ? matches[0] : undefined) : undefined
          }, () => undefined))
          .then(resolved => { pendingFiles.delete(key); if (resolved) { foundFiles.set(key, resolved); fileListeners.forEach(listener => listener(key)) } })
      }
      asked.current.add(key)
      return undefined
    }
    const openFile = (path: string) => rightPanelService.openFile(relativeFile(foundFiles.get(keyOf(path)) ?? path, target.cwd))
    return {
      fileMentions: { resolve(text: string) {
        const file = codeFilePath(text)
        const path = file === undefined ? undefined : locate(file)
        return path !== undefined ? { title: path, label: `打开 ${path}`, open: () => openFile(path), contextMenuProps: LINKED_FILE } : undefined
      } },
      delegate: { ...outer, openFile, getTriggerProps: (trigger: { kind: string; path?: string }) => trigger.kind !== 'file' ? outer.getTriggerProps?.(trigger)
        : { ...outer.getTriggerProps?.(trigger), ...(locate(trigger.path ?? '') !== undefined ? LINKED_FILE : PLAIN_FILE) } },
    }
  }, [target, outer, version])
}

export function StreamingText({ text, streaming = false, animate = streaming, fileLinks = true, ...props }: StreamingTextProps) {
  const body = useRef<HTMLDivElement>(null)
  const caret = useRef<HTMLSpanElement>(null)
  const decoration = useRef<StreamingDecoration | null>(null)
  const name = `nodo-stream-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const fileLinked = useFileLinks()
  const links = fileLinks ? fileLinked : null
  useLayoutEffect(() => {
    if (!body.current || !caret.current) return
    if (!decoration.current && (streaming || animate)) decoration.current = decorateStreamingText(body.current, caret.current, { name, streaming, animate })
    else decoration.current?.update(streaming, animate)
  }, [text, streaming, animate, name])
  useLayoutEffect(() => () => { decoration.current?.dispose(); decoration.current = null }, [name])
  return (
    <div className="nodo-streaming-text">
      <div ref={body}>{links
        ? <MarkdownDelegateProvider {...links.delegate}><MarkdownText {...props} text={text} streaming={streaming} fileMentions={links.fileMentions} /></MarkdownDelegateProvider>
        : <MarkdownText {...props} text={text} streaming={streaming} />}</div>
      <span ref={caret} className="nodo-streaming-caret" hidden aria-hidden />
    </div>
  )
}

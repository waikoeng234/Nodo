import {
  h, Fragment, useState, useEffect, useLayoutEffect, useRef, useSyncExternalStore, call,
  Button, CodeBlock, MarkdownText, ImageLightbox, MARKDOWN_LABELS,
  IconPanelLeftOutlineRegular, IconFolderOpenOutlineRegular, IconCodeOutlineRegular, IconCloseOutlineRegular, IconPlusOutlineRegular,
  IconChevronRightOutlineRegular, IconChevronDownOutlineRegular, IconChevronLeftOutlineRegular, IconGlobeOutlineRegular, IconBranchOutlineRegular,
} from './ui-shared.js'
import { ChangesView } from './changes-panel.tsx'
import type { ChangesSource } from './changes-panel.tsx'
import { BrowserView, browserTitle, normalizeBrowserAddress } from './browser.tsx'
import { TerminalView, terminalRequest, terminalScope, measureTerminal, TerminalMissingError } from './terminal.tsx'
import type { TerminalList, TerminalRecord, TerminalTarget } from './terminal.tsx'

type Target = TerminalTarget & { cwd?: string; readOnly?: boolean }
type Tab = { kind: 'files' } | ({ kind: 'terminal' } & TerminalRecord) | { kind: 'browser'; id: string; url: string; title: string }
  | { kind: 'changes'; id: 'changes'; source: ChangesSource; path?: string; version: number }
const terminalTab = ({ id, cols, rows, shell }: TerminalRecord): Tab =>
  ({ kind: 'terminal', id, ...(cols && rows ? { cols, rows } : {}), ...(shell ? { shell } : {}) })
const tabId = (tab: Tab) => tab.kind === 'files' ? 'files' : tab.id
type PanelState = { target: Target | null; expanded: boolean; tabs: Tab[]; active: string; selected: string; available: boolean; creating: boolean; error: string }
export type RightPanelService = {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => PanelState
  bind: (target: Target) => () => void
  toggle: () => void
  openFiles: () => void
  openFile: (path: string) => void
  openChanges: (source: ChangesSource, path?: string) => void
  selectFile: (path: string) => void
  openHome: () => void
  newTerminal: (element: HTMLElement | null) => Promise<void>
  newBrowser: (url?: string) => void
  updateBrowser: (id: string, url: string, title: string) => void
  forgetTab: (id: string) => void
  selectTab: (id: string) => void
  closeTab: (id: string) => Promise<void>
}

export function createRightPanel(ctx: {
  slots: {
    inject: (name: string, run: () => () => void) => void
    register: (options: { name: string; id?: string; priority?: number }, component: (props: { width: number }) => ReturnType<typeof RightPanel>) => () => void
  }
  layout: { openRightbar: (track: boolean, fullscreen: boolean) => void; closeRightbar: () => void }
}): RightPanelService {
  let state: PanelState = { target: null, expanded: false, tabs: [], active: '', selected: '', available: false, creating: false, error: '' }
  let generation = 0
  let browserSequence = 0
  let changesSequence = 0
  let bound: Target | undefined
  const listeners = new Set<() => void>()
  const closed = new Set<string>()
  const directories = new Map<string, string>()
  const normalized = (cwd?: string) => cwd && (directories.get(cwd) ?? cwd)
  const publish = (changes: Partial<PanelState>) => {
    state = { ...state, ...changes }
    for (const listener of listeners) listener()
  }
  const panel: RightPanelService = {
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    getSnapshot: () => state,
    bind(target) {
      const current = ++generation
      const previous = bound
      let adopted = false
      const adopt = (cwd = target.cwd) => {
        const same = !!cwd && normalized((adopted ? bound : previous)?.cwd) === normalized(cwd)
        bound = { ...target, cwd: normalized(cwd) }
        const tabs = (same ? state.tabs : state.tabs.filter(tab => tab.kind === 'files')).filter(tab => !target.readOnly || tab.kind !== 'terminal')
        publish({ target: bound, tabs, selected: same ? state.selected : '', active: same && (state.active === '' || tabs.some(tab => tabId(tab) === state.active)) ? state.active : tabs[0] ? tabId(tabs[0]) : '', available: false, creating: false, ...(adopted ? {} : { error: '' }) })
        adopted = true
      }
      if (!previous || normalized(previous.cwd) === normalized(target.cwd) || target.readOnly) adopt()
      else publish({ available: false, creating: false, error: '' })
      const restore = async () => {
        for (let attempt = 0; attempt < 2 && current === generation; attempt++) {
          try {
            const value: TerminalList = await terminalRequest('list', terminalScope(target))
            if (target.cwd && value.cwd) directories.set(target.cwd, value.cwd)
            if (current !== generation) return
            adopt(value.cwd ?? target.cwd)
            const restored = value.terminals.filter(terminal => !closed.has(terminal.id))
            const tabs: Tab[] = [...state.tabs.filter(tab => tab.kind !== 'terminal' || restored.some(terminal => terminal.id === tab.id)),
              ...restored.filter(terminal => !state.tabs.some(tab => tabId(tab) === terminal.id)).map(terminalTab)]
            publish({ target: bound, tabs, available: value.available, active: tabs.some(tab => tabId(tab) === state.active) ? state.active : tabs[0] ? tabId(tabs[0]) : '',
              error: state.error === '无法加载终端列表' || state.error === '终端列表加载失败，正在重试…' ? '' : state.error })
            return
          } catch {
            if (current === generation) {
              if (!adopted) adopt()
              publish({ error: attempt ? '无法加载终端列表' : '终端列表加载失败，正在重试…' })
            }
          }
        }
      }
      if (!target.readOnly) void restore()
      // React cleans up the old page before binding its replacement.
      return () => { void Promise.resolve().then(() => { if (current === generation) { generation++; publish({ target: null }) } }) }
    },
    toggle: () => publish({ expanded: !state.expanded }),
    openFiles: () => publish({ tabs: state.tabs.some(tab => tab.kind === 'files') ? state.tabs : [...state.tabs, { kind: 'files' }], active: 'files' }),
    openFile(path) { if (state.target) { panel.openFiles(); publish({ expanded: true, selected: path }) } },
    openChanges(source, path) {
      if (!state.target) return
      const tab: Tab = { kind: 'changes', id: 'changes', source, path, version: ++changesSequence }
      publish({ tabs: state.tabs.some(tab => tab.kind === 'changes') ? state.tabs.map(current => current.kind === 'changes' ? tab : current) : [...state.tabs, tab], active: 'changes', expanded: true })
    },
    selectFile: selected => publish({ selected }),
    openHome: () => { if (state.active) publish({ active: '' }) },
    selectTab: active => publish({ active }),
    newBrowser(value = '') {
      if (!state.target) return
      const url = value ? normalizeBrowserAddress(value) : ''
      if (url === null) return
      const id = `browser-${++browserSequence}`
      publish({ tabs: [...state.tabs, { kind: 'browser', id, url, title: browserTitle(url) }], active: id })
    },
    updateBrowser(id, url, title) {
      if (state.tabs.some(tab => tab.kind === 'browser' && tab.id === id && (tab.title !== title || tab.url !== url))) {
        publish({ tabs: state.tabs.map(tab => tab.kind === 'browser' && tab.id === id ? { ...tab, url, title } : tab) })
      }
    },
    async newTerminal(element) {
      if (!state.target || !state.available || state.creating) return
      const current = generation, scope = terminalScope(state.target)
      publish({ creating: true, error: '' })
      try {
        const size = await measureTerminal(element)
        if (current !== generation) return
        const terminal: TerminalRecord = await terminalRequest('create', { ...scope, ...size })
        if (current === generation) publish({ tabs: [...state.tabs, terminalTab({ ...size, ...terminal })], active: terminal.id })
      } catch { if (current === generation) publish({ error: '无法新建终端' }) }
      finally { if (current === generation) publish({ creating: false }) }
    },
    forgetTab(id) {
      const tabs = state.tabs.filter(tab => tabId(tab) !== id)
      publish({ tabs, active: state.active === id ? tabs.at(-1) ? tabId(tabs[tabs.length - 1]) : '' : state.active, error: '' })
    },
    async closeTab(id) {
      const current = generation, target = state.target
      const index = state.tabs.findIndex(tab => tabId(tab) === id), tab = state.tabs[index]
      if (!tab || tab.kind === 'terminal' && target?.readOnly) return
      if (tab.kind === 'terminal') closed.add(id)
      panel.forgetTab(id)
      try {
        if (tab.kind === 'terminal' && target) await terminalRequest('close', { ...terminalScope(target), id })
      } catch (error) {
        if (!(error instanceof TerminalMissingError)) {
          closed.delete(id)
          if (current === generation) publish({ tabs: [...state.tabs.slice(0, index), tab, ...state.tabs.slice(index)],
            active: state.active || id, error: '无法关闭终端' })
        }
      }
    },
  }
  ctx.slots.inject('rightbar', () => {
    let unregister: (() => void) | undefined
    let owned = false
    const close = () => { if (owned) ctx.layout.closeRightbar(); owned = false }
    const Owner = ({ width }: { width: number }) => {
      const { expanded } = useSyncExternalStore(panel.subscribe, panel.getSnapshot)
      useLayoutEffect(() => { owned = true; return () => { owned = false } }, [])
      useLayoutEffect(() => {
        if (expanded) ctx.layout.openRightbar(true, false)
        else ctx.layout.closeRightbar()
      }, [expanded])
      return <RightPanel panel={panel} width={width} />
    }
    const update = () => {
      if (state.target && !unregister) unregister = ctx.slots.register({ name: 'rightbar', priority: -100 }, Owner)
      if (!state.target && unregister) { close(); unregister(); unregister = undefined }
    }
    const stop = panel.subscribe(update)
    update()
    return () => { stop(); if (unregister) { close(); unregister() } }
  })
  ctx.slots.inject('shell.overlay', () => {
    let unregister: (() => void) | undefined
    const Toggle = () => <div className="nodo-right-control"><RightPanelToggle panel={panel} /></div>
    const update = () => {
      if (state.target && !unregister) unregister = ctx.slots.register({ name: 'shell.overlay', id: 'nodo.right-toggle' }, Toggle)
      if (!state.target && unregister) { unregister(); unregister = undefined }
    }
    const stop = panel.subscribe(update)
    update()
    return () => { stop(); unregister?.() }
  })
  return panel
}

export function RightPanelToggle({ panel }: { panel: RightPanelService }) {
  const state = useSyncExternalStore(panel.subscribe, panel.getSnapshot)
  return <Button variant="ghost" className="nodo-right-toggle" aria-label={state.expanded ? '收起右侧栏' : '展开右侧栏'}
    aria-expanded={state.expanded} onClick={panel.toggle} icon={<IconPanelLeftOutlineRegular size={16} className="nodo-right-glyph" />} />
}

export function RightPanel({ panel, width }: { panel: RightPanelService; width: number }) {
  const state = useSyncExternalStore(panel.subscribe, panel.getSnapshot)
  const content = useRef<HTMLDivElement | null>(null)
  const create = () => void panel.newTerminal(content.current)
  const target = state.target
  if (!target) return null
  const counts = new Map<string, number>()
  const titles = state.tabs.map(tab => {
    const title = tab.kind === 'files' ? '项目文件' : tab.kind === 'changes' ? '变更' : tab.kind === 'browser' ? tab.title : tab.shell || '终端'
    const base = tab.kind === 'browser' && title.length > 28 ? `${title.slice(0, 27)}…` : title
    const nth = (counts.get(base) ?? 0) + 1
    counts.set(base, nth)
    return nth > 1 ? `${base} ${nth}` : base
  })
  return <aside className="nodo-right-panel" aria-label="会话工具" hidden={!state.expanded} style={{ width }}>
    <header className="nodo-right-head">
      <div className="nodo-right-tabs" role="tablist" aria-label="会话工具" onKeyDown={event => {
        const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key]
        const at = state.tabs.findIndex(tab => tabId(tab) === state.active)
        if (!step || at < 0 || !(event.target as HTMLElement).matches('[role=tab]')) return
        event.preventDefault()
        const next = tabId(state.tabs[(at + step + state.tabs.length) % state.tabs.length])
        panel.selectTab(next)
        document.getElementById(`nodo-right-tab-${next}`)?.focus()
      }}>
        {state.tabs.map((tab, index) => <div key={tabId(tab)} className="nodo-right-tab" data-active={state.active === tabId(tab) || undefined}>
          <button type="button" role="tab" id={`nodo-right-tab-${tabId(tab)}`} aria-controls={`nodo-right-pane-${tabId(tab)}`}
            aria-selected={state.active === tabId(tab)} tabIndex={state.active === tabId(tab) ? 0 : -1} onClick={() => panel.selectTab(tabId(tab))}>
            {tab.kind === 'files' ? <IconFolderOpenOutlineRegular size={14} /> : tab.kind === 'changes' ? <IconBranchOutlineRegular size={14} /> : tab.kind === 'browser' ? <IconGlobeOutlineRegular size={14} /> : <IconCodeOutlineRegular size={14} />}{titles[index]}
          </button>
          <Button variant="ghost" className="nodo-right-tab-close" aria-label={`关闭${titles[index]}`}
            onClick={() => void panel.closeTab(tabId(tab))} icon={<IconCloseOutlineRegular size={14} />} />
        </div>)}
        {state.tabs.length > 0 && <Button variant="ghost" aria-label="新建标签页" onClick={panel.openHome} icon={<IconPlusOutlineRegular size={14} />} />}
      </div>
    </header>
    <div className="nodo-right-content" ref={content}>
      {state.error && status(state.error)}
      {state.tabs.map(tab => <div key={tabId(tab)} id={`nodo-right-pane-${tabId(tab)}`} className="nodo-right-pane" role="tabpanel"
        aria-labelledby={`nodo-right-tab-${tabId(tab)}`} hidden={state.active !== tabId(tab)}>
        {tab.kind === 'files' ? <WorkspaceFiles key={target.cwd} target={target} selected={state.selected} onSelect={panel.selectFile} />
          : tab.kind === 'changes' ? <ChangesView key={tab.version} source={tab.source} initialPath={tab.path} openFile={panel.openFile} />
          : tab.kind === 'browser' ? <BrowserView cwd={target.cwd} initialUrl={tab.url}
            onChange={(url, title) => panel.updateBrowser(tab.id, url, title)} onOpen={panel.newBrowser} />
          : <TerminalView id={tab.id} target={target} initialSize={tab.cols && tab.rows ? { cols: tab.cols, rows: tab.rows } : undefined}
            active={state.active === tab.id && state.expanded} onGone={() => panel.forgetTab(tab.id)} />}
      </div>)}
      {state.active === '' && <div className="nodo-right-home">
          <button type="button" className="nodo-right-card" onClick={panel.openFiles}>
            <IconFolderOpenOutlineRegular size={20} /><span><strong>项目文件</strong>{target.cwd && <small title={target.cwd}>{target.cwd}</small>}</span>
          </button>
          {state.available && <button type="button" className="nodo-right-card" disabled={state.creating} onClick={create}>
            <IconCodeOutlineRegular size={20} /><span><strong>新建终端</strong>{target.cwd && <small title={target.cwd}>{target.cwd}</small>}</span>
          </button>}
          <button type="button" className="nodo-right-card" onClick={() => panel.newBrowser()}>
            <IconGlobeOutlineRegular size={20} /><span><strong>浏览器</strong></span>
          </button>
        </div>}
    </div>
  </aside>
}

type Entry = { name: string; kind: 'dir' | 'file' }
type Directory = { entries?: Entry[]; truncated?: boolean; error?: boolean }
type FileContent = { text?: string; image?: { mediaType: string; dataUrl: string }; binary?: boolean; truncated?: boolean; missing?: boolean }
const status = (text: string) => <p className="nodo-right-status" role="status">{text}</p>

export function WorkspaceFiles({ target, selected: selection, onSelect }: { target: Target; selected?: string; onSelect?: (path: string) => void }) {
  const [directories, setDirectories] = useState<Record<string, Directory>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ '': true })
  const [localSelected, setLocalSelected] = useState('')
  const selected = selection ?? localSelected, setSelected = onSelect ?? setLocalSelected
  const live = useRef(false)
  const pending = useRef(new Set<string>())
  useEffect(() => {
    live.current = true
    return () => { live.current = false; pending.current.clear() }
  }, [])
  useEffect(() => {
    for (const path of Object.keys(expanded).filter(path => expanded[path] && !directories[path] && !pending.current.has(path))) {
      pending.current.add(path)
      void call('workspace-dir', { ...terminalScope(target), path }).then((value: Directory) => {
        if (live.current) setDirectories(current => ({ ...current, [path]: value }))
      }).catch(() => { if (live.current) setDirectories(current => ({ ...current, [path]: { error: true } })) })
    }
  }, [expanded, directories, target])
  const branch = (path: string, depth: number): ReturnType<typeof h> => {
    const directory = directories[path]
    if (!directory) return status('加载中…')
    if (directory.error) return status('目录不可用')
    return <Fragment>
      {directory.entries?.map(entry => {
        const child = path ? `${path}/${entry.name}` : entry.name
        const isDir = entry.kind === 'dir'
        return <div key={child}>
          <button type="button" className="nodo-right-file" style={{ paddingInlineStart: 8 + depth * 14 }}
            aria-expanded={isDir ? !!expanded[child] : undefined} title={child}
            onClick={() => isDir ? setExpanded(current => ({ ...current, [child]: !current[child] })) : setSelected(child)}>
            {isDir ? <>{expanded[child] ? <IconChevronDownOutlineRegular size={12} /> : <IconChevronRightOutlineRegular size={12} />}<IconFolderOpenOutlineRegular size={14} /></>
              : <span className="nodo-right-file-icon"><IconCodeOutlineRegular size={14} /></span>}
            <span>{entry.name}</span>
          </button>
          {isDir && expanded[child] && branch(child, depth + 1)}
        </div>
      })}
      {directory.truncated && status('目录已截断')}
      {directory.entries?.length === 0 && status('空目录')}
    </Fragment>
  }
  return <div className="nodo-right-files">
    <div className="nodo-right-directory" hidden={!!selected}>{branch('', 0)}</div>
    {selected && <FilePreview key={selected} target={target} path={selected} onBack={() => setSelected('')} />}
  </div>
}

const LANGUAGES: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx', ts: 'typescript', tsx: 'tsx',
  md: 'markdown', json: 'json', css: 'css', html: 'html', py: 'python', rb: 'ruby', rs: 'rust', go: 'go',
  java: 'java', c: 'c', h: 'c', cpp: 'cpp', sh: 'bash', bash: 'bash', zsh: 'bash', yml: 'yaml', yaml: 'yaml', toml: 'toml',
}

export function FilePreview({ target, path, onBack }: { target: Target; path: string; onBack: () => void }) {
  const [content, setContent] = useState<FileContent | null>(null)
  const [error, setError] = useState(false)
  const [source, setSource] = useState(false)
  const [lightbox, setLightbox] = useState(false)
  const [imageError, setImageError] = useState(false)
  useEffect(() => {
    let live = true
    void call('workspace-file', { ...terminalScope(target), path }).then((value: FileContent) => { if (live) setContent(value) })
      .catch(() => { if (live) setError(true) })
    return () => { live = false }
  }, [target, path])
  const extension = path.split('.').at(-1)?.toLowerCase() ?? ''
  const markdown = extension === 'md' && typeof content?.text === 'string'
  return <div className="nodo-right-preview">
    <div className="nodo-right-preview-head">
      <Button variant="ghost" aria-label="返回文件树" onClick={onBack} icon={<IconChevronLeftOutlineRegular size={16} />} />
      <span title={path}>{path}</span>
      {markdown && <Button variant="ghost" aria-pressed={source} onClick={() => setSource(value => !value)}>{source ? '预览' : '源码'}</Button>}
    </div>
    <div className="nodo-right-preview-body">
      {content?.truncated && status('文件已截断')}
      {error ? status('文件不可用') : !content ? status('加载中…')
        : content.missing ? status('文件不存在') : content.binary ? status('二进制文件')
          : content.image ? imageError ? status('无法显示') : <button type="button" className="nodo-right-image" aria-label="放大图片" onClick={() => setLightbox(true)}><img src={content.image.dataUrl} alt={path} onError={() => setImageError(true)} /></button>
            : markdown && !source ? <MarkdownText text={content.text ?? ''} labels={MARKDOWN_LABELS} />
              : <CodeBlock code={content.text ?? ''} lang={LANGUAGES[extension] ?? 'text'} copyLabel="复制" copiedLabel="已复制" />}
    </div>
    {lightbox && !imageError && content?.image && <ImageLightbox src={content.image.dataUrl} alt={path} labels={{ dialog: '图片预览', close: '关闭预览' }} onClose={() => setLightbox(false)} />}
  </div>
}

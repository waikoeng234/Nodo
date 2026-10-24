// The feed keeps the host's message grammar: the user's own text is a right
// aligned bubble, the agent's reply is the host's Markdown renderer, and one tool
// call or thinking block is the host's own 24px disclosure row — a 14px family
// glyph, the name, a one-line summary, and the recorded text in the host's
// tool-output block once opened. Scrolling follows the host chat's follow policy:
// growth pins the floor only while the reader stays within FOLLOW_PX of it;
// scrolling away pauses following, and the floating button or a sent message
// resumes it.
import {
  h, Fragment, useState, useEffect, useRef, call, MARKDOWN_LABELS, TOOL_VARIANTS, toolVariant, DisclosureRow, MarkdownText, StateDot,
  Button, Menu, Modal, ComposerGlyph,
  IconSparkleRegular, IconThinkOutlineRegular, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconDataOutlineRegular,
  IconDatabaseOutlineRegular, IconGaugeOutlineRegular, IconRefreshOutlineRegular, IconPaperclipOutlineRegular, ImageLightbox,
  billedTokens, cacheHitPercent, contextPercent, compactTokens, compactDuration, exactTokens, tokensPerSecond, turnTokens,
} from './ui-shared.js'
import { supportedStreamRecord, StreamRecordCard } from './stream-records.js'

const FOLLOW_PX = 25

const brief = text => (text ?? '').slice(0, 400)

// The host ReasoningRow's streaming summary: while a block grows, it reads the
// first line of the latest completed paragraph; once settled, the block's own
// first line. Ported from dsh-client-ui-chat's latestCompletedParagraphFirstLine.
const completedLead = text => {
  let lead = ''
  let start = 0
  const separator = /\r?\n(?:[\t ]*\r?\n)+/g
  for (;;) {
    const next = separator.exec(text)
    const end = next === null ? text.length : next.index + next[0].indexOf('\n')
    const newline = text.indexOf('\n', start)
    if (newline !== -1 && newline <= end) {
      const candidate = text.slice(start, newline).trim()
      if (candidate !== '') lead = candidate
    }
    if (next === null) return lead
    start = next.index + next[0].length
  }
}

// One tool call or thinking block is the host's own 24px disclosure row: a 14px
// leading glyph, the title, a separator dot and a one-line summary; opening it
// shows the recorded text in the host's shapes — the tool IO card for a call, the
// compact Markdown body for reasoning.
export function ProcessRow({ kind, variant, title, summary, body, input, output, progress, running, error }) {
  const [open, setOpen] = useState(false)
  const text = typeof body === 'string' ? body.trim() : ''
  const expandable = text !== '' || Boolean(input) || Boolean(output) || Boolean(progress)
  const streaming = running === true
  const progressNote = progressText(progress)
  const collapsed = summary ? [
    h('span', { key: 'sep', className: 'nodo-tool-sep', 'data-shimmer-decoration': true, 'aria-hidden': true }),
    kind === 'thinking'
      ? h('span', { key: 'summary', className: 'nodo-think-summary', 'data-streaming': streaming ? '' : undefined }, summary)
      : h('span', { key: 'summary', className: 'nodo-row-summary', 'data-error': error ? '' : undefined }, summary),
  ] : null
  return h(DisclosureRow, {
    icon: (variant ?? TOOL_VARIANTS.generic).icon({ size: 14 }),
    title, open, expandable, running: streaming, expandOnRowClick: true, keepContentWhenOpen: true,
    contentClassName: 'nodo-row-content', contentLayoutClassName: 'nodo-row-content-layout',
    onToggle: () => setOpen(current => !current),
    collapsedContent: collapsed,
    children: kind === 'thinking'
      ? h('div', { className: 'nodo-think-body' }, h(MarkdownText, { text: body, streaming, labels: MARKDOWN_LABELS, variant: 'compact' }))
      : h('div', { className: 'nodo-io-card' },
        ...(progressNote ? [h('p', { className: 'nodo-note' }, progressNote)] : []),
        ...(input || output ? [['输入', input], ['输出', output]] : [[streaming ? '输入' : '输出', body]])
          .filter(([, value]) => value).map(([label, value]) => h('div', { key: label, className: 'nodo-io-section' },
            h('span', { className: 'nodo-io-label' }, label),
            h('span', { className: 'nodo-io-text', 'data-error': error && label === '输出' ? '' : undefined }, value))),
        ...(progress?.outputPreview ? [h('div', { key: 'output-preview', className: 'nodo-io-section' },
          h('span', { className: 'nodo-io-label' }, '输出预览'), h('span', { className: 'nodo-io-text' }, progress.outputPreview))] : []),
        ...(progress?.stdoutTail ? [h('div', { key: 'stdout-tail', className: 'nodo-io-section' },
          h('span', { className: 'nodo-io-label' }, 'stdout（尾部）'), h('span', { className: 'nodo-io-text' }, progress.stdoutTail))] : []),
        ...(progress?.stderrTail ? [h('div', { key: 'stderr-tail', className: 'nodo-io-section' },
          h('span', { className: 'nodo-io-label' }, 'stderr（尾部）'), h('span', { className: 'nodo-io-text' }, progress.stderrTail))] : [])),
  })
}

const sizeText = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
function progressText(progress) {
  if (!progress || typeof progress !== 'object') return null
  const parts = []
  if (Number.isFinite(progress.elapsedMs)) parts.push(`已用时 ${(progress.elapsedMs / 1000).toFixed(1)} 秒`)
  if (typeof progress.message === 'string' && progress.message !== '') parts.push(progress.message.slice(0, 200))
  if (Number.isFinite(progress.outputBytes)) parts.push(`输出 ${sizeText(progress.outputBytes)}`)
  if (Number.isFinite(progress.stdoutBytes)) parts.push(`stdout ${sizeText(progress.stdoutBytes)}`)
  if (Number.isFinite(progress.stderrBytes)) parts.push(`stderr ${sizeText(progress.stderrBytes)}`)
  return parts.length ? parts.join(' · ') : null
}

// The engine's plan: one replaceable row per turn showing the step list the
// source last sent — updates rewrite it in place, they never append.
export function PlanRow({ plan, running }) {
  const [open, setOpen] = useState(false)
  const steps = Array.isArray(plan.steps) ? plan.steps : []
  const active = steps.find(step => step.status === 'in_progress') ?? steps[0]
  const summary = active ? String(active.text).split('\n')[0] : plan.text ? String(plan.text).split('\n')[0] : null
  // A markdown-form plan has no steps but a real body: it still expands.
  const expandable = steps.length > 0 || Boolean(plan.text)
  return h(DisclosureRow, {
    icon: TOOL_VARIANTS.plan.icon({ size: 14 }),
    title: '计划', open, expandable, running, expandOnRowClick: expandable, keepContentWhenOpen: true,
    contentClassName: 'nodo-row-content', contentLayoutClassName: 'nodo-row-content-layout',
    onToggle: () => setOpen(state => !state),
    collapsedContent: summary ? [
      h('span', { key: 'sep', className: 'nodo-tool-sep', 'data-shimmer-decoration': true, 'aria-hidden': true }),
      h('span', { key: 'summary', className: 'nodo-row-summary', 'data-streaming': running ? '' : undefined }, summary),
    ] : null,
    children: steps.length > 0
      ? h('div', { className: 'nodo-plan-list' }, steps.map((step, index) => h('div', { key: index, className: 'nodo-plan-step', 'data-status': step.status ?? 'pending' },
        h('span', { className: 'nodo-plan-mark', 'aria-hidden': true }, step.status === 'completed' ? '✓' : step.status === 'in_progress' ? '•' : '○'),
        h('span', { className: 'nodo-plan-text' }, step.text))))
      : h('div', { className: 'nodo-plan-text' }, plan.text ?? ''),
  })
}

export function transcriptRows(lines) {
  const rows = []
  const open = new Map()
  for (const [index, item] of lines.entries()) {
    // A cleared plan leaves no row at all: its removal is the final state.
    if (item.kind === 'plan' && (item.removed === true
      || (( !Array.isArray(item.steps) || item.steps.length === 0) && !item.text))) continue
    if (item.kind !== 'tool') { rows.push({ item, index, running: false, error: false }); continue }
    if (item.phase === 'start') {
      open.set(item.callId ?? item.name, rows.length)
      rows.push({ item, index, running: true, error: false })
      continue
    }
    const at = item.callId ? open.get(item.callId) : open.get(item.name) ?? [...open.values()].pop()
    if (at === undefined) { rows.push({ item, index, running: false, error: item.isError === true }); continue }
    open.delete(rows[at].item.callId ?? rows[at].item.name)
    rows[at] = { ...rows[at], running: false, error: item.isError === true,
      item: { ...rows[at].item, brief: rows[at].item.brief ?? item.brief,
        activity: item.activity ?? rows[at].item.activity,
        parentCallId: item.parentCallId ?? rows[at].item.parentCallId,
        childId: item.childId ?? rows[at].item.childId,
        toolCallId: item.toolCallId ?? rows[at].item.toolCallId,
        input: item.input ?? rows[at].item.input, output: item.output ?? rows[at].item.output,
        progress: item.progress ?? rows[at].item.progress,
        presentation: item.presentation ?? rows[at].item.presentation } }
  }
  const groups = [[]]
  for (const row of rows) {
    if (row.item.who === 'user') groups.push([])
    if (row.item.kind === 'tool') groups.at(-1).push(row)
  }
  for (const group of groups) {
    const entities = new Map(group.filter(row => row.item.callId).map(row => [row.item.callId, row]))
    for (const row of group) {
      const seen = new Set([row.item.callId])
      let parent = entities.get(row.item.parentCallId)
      row.depth = 0
      while (parent && !seen.has(parent.item.callId) && row.depth < 8) {
        seen.add(parent.item.callId)
        row.depth += 1
        parent = entities.get(parent.item.parentCallId)
      }
      if (parent && seen.has(parent.item.callId)) row.depth = 0
    }
  }
  return rows
}

// Consecutive thinking, plan and tool rows form one process block, folded under
// a single disclosure; replies, errors and usage stay outside it.
const isProcess = row => row.item.kind === 'tool' || row.item.kind === 'thinking' || row.item.kind === 'plan'
function processBlocks(rows) {
  const blocks = []
  rows.forEach((row, position) => {
    const last = blocks.at(-1)
    if (isProcess(row) && last?.process) last.rows.push({ row, position })
    else blocks.push({ process: isProcess(row), rows: [{ row, position }] })
  })
  return blocks
}

export function ProcessGroup({ rows, running, children }) {
  const [open, setOpen] = useState(false)
  const thinking = rows.filter(item => item.kind === 'thinking').length
  const plans = rows.filter(item => item.kind === 'plan').length
  const activities = rows.filter(item => item.activity === true).length
  const tools = rows.length - thinking - plans - activities
  const summary = [thinking && `思考 ${thinking}`, tools && `工具 ${tools}`, activities && `子任务 ${activities}`, plans && `计划 ${plans}`].filter(Boolean).join(' · ')
  return h(DisclosureRow, {
    icon: IconSparkleRegular({ size: 14 }), title: '处理过程', open, expandable: true, running, expandOnRowClick: true, keepContentWhenOpen: true,
    contentClassName: 'nodo-row-content', contentLayoutClassName: 'nodo-row-content-layout',
    onToggle: () => setOpen(current => !current),
    collapsedContent: [
      h('span', { key: 'sep', className: 'nodo-tool-sep', 'data-shimmer-decoration': true, 'aria-hidden': true }),
      h('span', { key: 'summary', className: 'nodo-row-summary' }, summary),
    ],
    children: h('div', { className: 'nodo-process-group' }, children),
  })
}

export function Feed({ profile, session, revision, work, sentTick }) {
  const [feed, setFeed] = useState({ key: null, lines: [], error: '' })
  const [following, setFollowing] = useState(true)
  const [activeTurn, setActiveTurn] = useState(null)
  const key = `${profile.id}:${session?.id ?? ''}`
  const box = useRef(null)
  const probe = useRef(0)
  // One rAF-coalesced reader sample drives both follow intent and the rail's
  // active turn (the last turn starting above the reading line).
  const sample = () => {
    if (probe.current || typeof requestAnimationFrame !== 'function') return
    probe.current = requestAnimationFrame(() => {
      probe.current = 0
      const node = box.current
      if (node === null) return
      const near = node.scrollHeight - node.scrollTop - node.clientHeight <= FOLLOW_PX
      setFollowing(current => current === near ? current : near)
      let turn = null
      const rows = node.querySelectorAll('[data-nodo-turn]')
      if (rows.length) {
        turn = Number(rows[0].getAttribute('data-nodo-turn'))
        const reading = node.getBoundingClientRect().top + node.clientHeight / 3
        for (const row of rows) {
          if (row.getBoundingClientRect().top > reading) break
          turn = Number(row.getAttribute('data-nodo-turn'))
        }
      }
      setActiveTurn(turn)
    })
  }
  useEffect(() => () => { if (probe.current) cancelAnimationFrame(probe.current) }, [])
  // An idle transcript only moves with a revision; while the turn runs, the
  // per-tick refetch is what carries the host's in-memory tool row updates.
  useEffect(() => {
    if (!session) return
    let live = true
    void call('transcript', { profile: profile.id, session: session?.id }).then(lines => {
      if (live) setFeed({ key, lines, error: '' })
    }).catch(failure => { if (live) setFeed({ key, lines: [], error: failure.message }) })
    return () => { live = false }
  }, [key, revision, work?.active === true ? work : null])
  useEffect(() => {
    if (box.current !== null && following) box.current.scrollTop = box.current.scrollHeight
    sample()
  }, [feed, following])
  useEffect(() => { setFollowing(true) }, [sentTick])
  // One turn starts at each user line; the rail previews the prompt and the
  // first reply that follows it.
  const turns = []
  for (const [index, item] of feed.lines.entries()) {
    if (item.who === 'user') turns.push({ turn: index, prompt: brief(item.text), response: '' })
    else if (item.who === 'agent' && item.kind === 'text' && turns.length !== 0 && turns.at(-1).response === '') turns.at(-1).response = brief(item.text)
  }
  const goto = turn => {
    const node = box.current
    const row = node?.querySelector(`[data-nodo-turn="${turn}"]`)
    if (!node || !row) return
    setFollowing(false)
    node.scrollTop = row.getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop
  }
  const lines = feed.key === key ? feed.lines : []
  const rows = transcriptRows(lines)
  const newest = rows.length - 1
  const line = (row, position) => {
    const { item, index } = row
    if (item.kind === 'plan') return h(PlanRow, { key: index, plan: item, running: work?.active === true && index === newest })
    if (item.kind === 'changes' && supportedStreamRecord(item.presentation)) return h(StreamRecordCard, { key: index, record: item.presentation, request: { profile: profile.id, session: session.id } })
    if (item.kind === 'tool') {
      if (supportedStreamRecord(item.presentation)) return h(StreamRecordCard, { key: index, record: item.presentation, request: { profile: profile.id, session: session.id } })
      const variant = TOOL_VARIANTS[toolVariant(item.name)]
      const progress = progressText(item.progress)
      return h(ProcessRow, {
        key: index, kind: 'tool', variant, title: variant.title,
        summary: [item.brief ? item.brief.split('\n')[0] : null, progress].filter(Boolean).join(' · ') || null,
        body: item.brief ?? '',
        input: item.input, output: item.output, progress: item.progress,
        running: row.running && work?.active === true, error: row.error,
      })
    }
    if (item.kind === 'thinking') {
      const text = item.text ?? ''
      // The host chat's rule: a reasoning row is running while it is the
      // streaming tail, and its summary then advances per completed paragraph.
      const running = work?.active === true && index === newest && (work.buffer ?? '') === ''
      const lead = (running ? completedLead(text) : '') || text.split('\n')[0] || ''
      return h(ProcessRow, {
        key: index, kind: 'thinking', variant: { icon: IconThinkOutlineRegular }, title: '思考',
        summary: lead.replaceAll('**', '') || null, body: text, running,
      })
    }
    if (item.kind === 'error') {
      return h('div', { key: index, className: 'nodo-turn-error' },
        h(StateDot, { state: 'error', size: 8, className: 'nodo-turn-error-dot' }),
        h('span', null, h('span', { className: 'nodo-turn-error-title' }, '本轮运行失败'), item.text))
    }
    // A turn's usage lands under its reply as the host chat's own caption.
    if (item.kind === 'usage') return lines[index - 1]?.who === 'agent' && lines[index - 1].kind === 'text' ? null : h(TurnUsage, { key: index, usage: item.usage })
    if (item.who === 'user') {
      return h('div', { key: index, className: 'nodo-user', 'data-flow': 'user', 'data-nodo-turn': index },
        h('div', { className: 'nodo-bubble' },
          item.files?.length > 0 && h('span', { className: 'nodo-user-files' }, item.files.map((file, at) => h('span', { key: file.id ?? at, className: 'nodo-composer-file' },
            h(IconPaperclipOutlineRegular, { size: 14 }), h('span', { title: file.name }, file.name)))),
          item.images?.map(image => h(TranscriptImage, { key: image.id, image })), item.text),
        h(MessageTime, { at: item.at }))
    }
    if (item.who === 'agent') {
      const usage = lines[index + 1]?.kind === 'usage' ? lines[index + 1].usage : null
      return h('div', { key: index, className: 'nodo-reply', 'data-flow': 'response' },
        h(MarkdownText, { text: item.text, labels: MARKDOWN_LABELS }),
        item.images?.map(image => h(TranscriptImage, { key: image.id, image })),
        h('div', { className: 'nodo-reply-foot' }, h(MessageTime, { at: item.at }), usage && h(TurnUsage, { usage })))
    }
    return item.text ? h('p', { key: index, className: 'nodo-note' }, item.text) : null
  }
  return h('div', { className: 'nodo-feedwrap' },
    h('div', { className: 'nodo-feed', ref: box, onScroll: sample, 'data-following': following ? '' : undefined, role: 'log', 'aria-label': `${profile.name} transcript` },
      h('div', { className: 'nodo-feed-inner' },
        feed.key === key && feed.error && h('p', { className: 'nodo-error-line', role: 'alert' }, feed.error),
        lines.length === 0 && !work?.active && h('p', { className: 'nodo-note nodo-feed-empty' },
          `还没有消息。给「${profile.name}」发一条任务，一条消息即一个任务。`),
        ...processBlocks(rows).map((block, index, all) => block.process
          ? h(ProcessGroup, { key: block.rows[0].row.index, rows: block.rows.map(({ row }) => row.item), running: work?.active === true && index === all.length - 1 },
            block.rows.map(({ row, position }) => row.depth > 0
              ? h('div', { key: row.index, 'data-nodo-depth': row.depth, style: { marginLeft: `${row.depth * 16}px` } }, line(row, position))
              : line(row, position)))
          : line(block.rows[0].row, block.rows[0].position)),
        work?.active && work.buffer != null && work.buffer !== '' && h('div', { className: 'nodo-reply', 'data-flow': 'response' },
          h(MarkdownText, { text: work.buffer, streaming: true, labels: MARKDOWN_LABELS })))),
    h(TurnRail, { turns, activeTurn, busyTurn: work?.active === true ? turns.at(-1)?.turn ?? null : null, onNavigate: goto }),
    !following && h('button', { type: 'button', className: 'nodo-tobottom', 'aria-label': '回到底部', title: '回到底部', onClick: () => setFollowing(true) },
      h(IconChevronDownOutlineRegular)))
}

// Right-edge turn ladder, the host chat's TurnNavigator cut to a fully loaded
// window: one fixed-pitch mark per turn, hover previews, click aligns that
// turn's first row below the top edge.
function TurnRail({ turns, activeTurn, busyTurn, onNavigate }) {
  const [previewTurn, setPreviewTurn] = useState(null)
  const [focusedTurn, setFocusedTurn] = useState(null)
  const [edges, setEdges] = useState({ top: false, bottom: false })
  const scroller = useRef(null)
  const inside = useRef(false)
  const previewId = useRef(`nodo-turn-preview-${Math.random().toString(36).slice(2, 8)}`).current
  const activeIndex = turns.findIndex(item => item.turn === activeTurn)
  const previewIndex = turns.findIndex(item => item.turn === (focusedTurn ?? previewTurn))
  const syncEdges = () => {
    const node = scroller.current
    if (node === null) return
    const next = { top: node.scrollTop > 1, bottom: node.scrollTop < node.scrollHeight - node.clientHeight - 1 }
    // Same object when nothing moved: the effect below runs on every commit, so a
    // fresh object each time would re-render forever.
    setEdges(current => current.top === next.top && current.bottom === next.bottom ? current : next)
  }
  // Re-derived on every commit: keep the fades honest and the active mark
  // inside the fade-free band, but never move the rail under a pointer on it.
  useEffect(() => {
    syncEdges()
    const node = scroller.current
    const mark = activeIndex >= 0 ? node?.querySelector(`[data-index="${activeIndex}"]`) : null
    if (node === null || mark === null || inside.current) return
    const center = mark.offsetTop + mark.offsetHeight / 2
    if (center < node.scrollTop + 24 || center > node.scrollTop + node.clientHeight - 24) node.scrollTop = center - node.clientHeight / 2
  })
  if (turns.length < 2) return null
  const preview = previewIndex >= 0 ? turns[previewIndex] : null
  const previewMark = previewIndex >= 0 ? scroller.current?.querySelector(`[data-index="${previewIndex}"]`) : null
  const center = previewMark ? previewMark.offsetTop + previewMark.offsetHeight / 2 - (scroller.current?.scrollTop ?? 0) : 0
  return h('nav', { className: 'nodo-turnrail', 'aria-label': '轮次导航',
      onPointerEnter: () => { inside.current = true },
      onPointerLeave: () => { inside.current = false; setPreviewTurn(null); setFocusedTurn(null) } },
    h('div', { className: `nodo-turnrail-scroller${edges.top ? ' nodo-turnrail-fade-top' : ''}${edges.bottom ? ' nodo-turnrail-fade-bottom' : ''}`, ref: scroller, onScroll: syncEdges },
      h('div', { className: 'nodo-turnrail-marks' }, turns.map((item, index) => h('button', {
        key: item.turn, type: 'button', 'data-index': index,
        className: `nodo-turnmark${item.turn === activeTurn ? ' nodo-turnmark-active' : ''}${index === previewIndex ? ' nodo-turnmark-preview' : ''}${item.turn === busyTurn ? ' nodo-turnmark-busy' : ''}`,
        'aria-label': `跳转到第 ${index + 1} 轮`, 'aria-current': item.turn === activeTurn ? 'true' : undefined,
        'aria-describedby': index === previewIndex ? previewId : undefined,
        onPointerMove: () => setPreviewTurn(item.turn),
        onFocus: () => { setFocusedTurn(item.turn); setPreviewTurn(item.turn) },
        onBlur: () => setFocusedTurn(null),
        onClick: () => onNavigate(item.turn),
      })))),
    preview && h('div', { id: previewId, role: 'tooltip', className: 'nodo-turnpreview', style: { '--nodo-preview-center': `${center}px` } },
      h('div', { className: 'nodo-turnpreview-prompt' }, preview.prompt || `第 ${previewIndex + 1} 轮`),
      preview.response !== '' && h('div', { className: 'nodo-turnpreview-response' }, preview.response)))
}

// The composer's model picker is the host composer's own trigger: the model
// name and reasoning level next to the send key, opening the drill-down menu —
// 模型 / 推理等级 rows, then the lists. It edits the role card's model and
// thinking only; the provider itself is chosen on the role card, so no engine
// row exists here. Catalog values come from the engine's cached scan, fetched
// on mount so the trigger can resolve labels without a first open; an engine
// never scanned is scanned on first open.
export function ModelPicker({ profile, disabled, onChange }) {  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState('root')
  const [engines, setEngines] = useState([])
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState('')
  const loaded = useRef(new Set())
  useEffect(() => {
    let live = true
    void call('engine-catalog').then(items => { if (live) setEngines(items) }).catch(() => {})
    return () => { live = false }
  }, [])
  const engine = engines.find(item => item.id === profile.engine)
  const models = engine?.catalog?.models ?? []
  // An unset model reads the catalog's default, an unset level reads the model's,
  // so the trigger never lies.
  const selectedModel = models.find(item => item.id === (profile.model || engine?.catalog?.defaultModel))
  const model = selectedModel?.id ?? profile.model ?? ''
  const levels = selectedModel?.thinking ?? []
  const thinking = profile.thinking || (levels.some(level => level.id === selectedModel?.defaultThinking) ? selectedModel.defaultThinking : '')
  const modelText = selectedModel ? selectedModel.label ?? modelName(selectedModel.id) : modelName(model) || engine?.label || profile.engine
  const levelText = thinking ? levels.find(level => level.id === thinking)?.label ?? thinking : ''
  const close = () => { setOpen(false); setPane('root') }
  const openMenu = () => {
    if (open) return close()
    setOpen(true)
    if (loaded.current.has(profile.engine)) return
    loaded.current.add(profile.engine)
    void call('engine-catalog').then(items => {
      setEngines(items)
      if (!items.some(item => item.id === profile.engine && !item.catalog)) return
      setScanning(true)
      return call('engine-scan', { engine: profile.engine })
        .then(catalog => setEngines(current => current.map(item => item.id === profile.engine ? { ...item, catalog } : item)))
    }).catch(failure => { loaded.current.delete(profile.engine); setError(failure.message) })
      .finally(() => setScanning(false))
  }
  // The model list is sectioned by provider like the host's own picker: a label
  // row names the provider, the rows under it are model names alone.
  const providers = new Map()
  for (const item of models) providers.set(item.group ?? '', [...(providers.get(item.group ?? '') ?? []), item])
  const modelItems = [...providers].flatMap(([group, items]) => [
    ...(group === '' ? [] : [{ type: 'label', id: `group:${group}`, text: group }]),
    ...items.map(item => ({ id: `model:${item.id}`, label: item.label ?? item.id })),
  ])
  // A model switch keeps the level only while the next model lists it; the
  // empty level reads the model's own default, as on the role card.
  const pick = id => {
    if (id === 'model' || id === 'thinking') { setPane(id); return }
    if (id.startsWith('group:')) return
    const changes = id.startsWith('model:')
      ? { model: id.slice(6), thinking: (models.find(item => item.id === id.slice(6))?.thinking ?? []).some(level => level.id === thinking) ? thinking : '' }
      : { ...(model ? { model } : {}), thinking: id.slice(9) }
    close()
    onChange(changes)
  }
  const cell = (label, value, filled) => h('span', { className: 'nodo-model-cell' },
    h('span', { className: 'nodo-model-cell-label' }, label),
    h('span', { className: 'nodo-model-cell-value' }, value),
    filled && h('span', { className: 'nodo-model-cell-chev' }, h(IconChevronRightOutlineRegular, { size: 12 })))
  const items = pane === 'model'
    ? models.length ? modelItems
      : [{ type: 'label', id: 'hint', text: scanning ? '正在扫描本地配置…' : error || '未扫描到模型，可在设置中重新扫描' }]
    : pane === 'thinking'
      ? [{ id: 'thinking:', label: '默认（跟随 Agent 设置）' },
        ...levels.map(level => ({ id: `thinking:${level.id}`,
          label: level.id === selectedModel?.defaultThinking ? `${level.label ?? level.id}（模型默认）` : level.label ?? level.id }))]
      : [
        { id: 'model', label: cell('模型', modelText, models.length > 0), disabled: !models.length },
        { id: 'thinking', label: cell('推理等级', levelText || '默认', levels.length > 0), disabled: !levels.length },
      ]
  // `listClassName` is the only hook that reaches a portaled card: the model
  // list takes the native picker's own metrics (ui-model-selection
  // ModelSelect.module.css `.menu`) instead of the host Menu's window-high cap.
  return h(Menu, {
    open, onClose: close, portal: true, side: 'top', align: 'end', autoFocus: true, className: 'nodo-model',
    listClassName: 'nodo-model-list',
    selectedId: pane === 'model' ? `model:${model}` : pane === 'thinking' ? `thinking:${thinking}` : undefined,
    items, onSelect: pick,
    anchor: h('button', {
      type: 'button', className: 'nodo-model-trigger', disabled,
      'aria-haspopup': 'menu', 'aria-expanded': open,
      'aria-label': `选择模型，当前 ${modelText}${levelText ? `，推理等级 ${levelText}` : ''}`,
      onClick: openMenu,
    },
    h(IconDataOutlineRegular, { size: 16, className: 'nodo-model-icon' }),
    h('span', { className: 'nodo-model-label' }, modelText),
    levelText !== '' && h('span', { className: 'nodo-model-effort' }, levelText),
    h('span', { className: 'nodo-chevron', 'data-open': open ? '' : undefined }, h(IconChevronDownOutlineRegular, { size: 14 }))),
  })
}

// A saved model is the route the engine is addressed by, not the name it is
// called: ZCode routes read `providerId$modelId` and the DSH pair a JSON array.
// A route the catalog cannot explain yet — an engine never scanned — still shows
// the model's own name, the same wording a resolved catalog label carries.
export function modelName(raw) {
  const id = typeof raw === 'string' ? raw : ''
  if (id.startsWith('[')) {
    try {
      const [, model] = JSON.parse(id)
      if (typeof model === 'string' && model !== '') return model
    } catch { /* not a JSON route pair; read it as a plain id */ }
  }
  const at = id.indexOf('$')
  return at > 0 && at < id.length - 1 ? id.slice(at + 1) : id
}

// Transcript images load by id on mount, so the transcript holds only references.
export function TranscriptImage({ image }) {
  const [src, setSrc] = useState(null)
  const [error, setError] = useState(false)
  const [preview, setPreview] = useState(false)
  useEffect(() => {
    let live = true
    setSrc(null); setError(false); setPreview(false)
    call('attachment', { id: image.id, mediaType: image.mediaType })
      .then(value => { if (live) setSrc(`data:${value.mediaType};base64,${value.data}`) })
      .catch(() => { if (live) setError(true) })
    return () => { live = false }
  }, [image.id, image.mediaType])
  const alt = image.name || '图片'
  return h(Fragment, null,
    error ? h('span', { className: 'nodo-note', role: 'status' }, `${alt}：图片不可用`)
      : h('button', { type: 'button', className: 'nodo-image-preview', disabled: !src, 'aria-label': `预览 ${alt}`, onClick: () => setPreview(true) },
        src ? h('img', { className: 'nodo-attachment', src, alt, onError: () => setError(true) }) : '正在加载图片…'),
    preview && src && h(ImageLightbox, { src, alt, labels: { dialog: '图片预览', close: '关闭预览' }, onClose: () => setPreview(false) }))
}

// One turn's own usage sits under its reply as the host chat's caption; a turn
// whose engine reported nothing keeps no caption at all.
// A transcript line's stamp as the host clock reads it: the time alone for today,
// with the date for anything older.
const clockText = at => {
  if (!Number.isFinite(at)) return ''
  const date = new Date(at)
  const sameDay = date.toDateString() === new Date().toDateString()
  return new Intl.DateTimeFormat('zh-CN', sameDay
    ? { hour: '2-digit', minute: '2-digit', hour12: false }
    : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}

function MessageTime({ at }) {
  const text = clockText(at)
  return text === '' ? null : h('time', { className: 'nodo-msg-time', dateTime: new Date(at).toISOString() }, text)
}

export function TurnUsage({ usage }) {
  const total = turnTokens(usage ?? {})
  return total > 0 ? h('div', { className: 'nodo-turn-usage', title: '本轮用量' }, `${compactTokens(total)} tok`) : null
}

// The composer's statistics line, the host chat's own three pills: rounds, steps
// and the decode speed; the token buckets with the cache-hit share; and how much
// of the context window the newest request occupies. A figure the session has no
// data for is left out rather than shown as a zero, and pressing the line opens
// the session statistics dialog.
export function SessionStats({ stats, onOpen }) {
  if (stats === undefined) return null
  const billed = billedTokens(stats)
  const total = billed + stats.outputTokens
  const hit = cacheHitPercent(stats)
  const context = contextPercent(stats)
  const group = (key, icon, values) => h('span', { key, className: 'nodo-stats-group' },
    h(icon, { size: 14 }),
    h('span', null, values.filter(value => value !== '').join(' · ')))
  const groups = []
  if (stats.turns > 0 || stats.decodeMs > 0) {
    groups.push(group('counts', IconRefreshOutlineRegular, [
      stats.turns > 0 ? `${stats.turns} 轮 ${stats.steps} 步` : '',
      stats.decodeMs > 0 && stats.decodeTokens > 0 ? `${tokensPerSecond(stats.decodeTokens, stats.decodeMs)} tok/s` : '',
    ]))
  }
  if (total > 0) {
    groups.push(group('tokens', IconDatabaseOutlineRegular, [
      `${compactTokens(total)} tok`,
      hit === '' ? '' : `缓存命中 ${hit}%`,
    ]))
  }
  if (context !== null) groups.push(group('context', IconGaugeOutlineRegular, [`${context}%`]))
  if (groups.length === 0) return null
  return h('button', {
    type: 'button', className: 'nodo-stats-pill', onClick: onOpen,
    'aria-haspopup': 'dialog', 'aria-label': '会话统计', title: '会话统计',
  }, groups)
}

// The dialog the statistics line opens: the host chat's own session statistics —
// token usage per bucket, cache hit, model and tool wall time, the average first
// token latency and the output speed. Only the figures this session has are shown.
export function StatsDialog({ stats, onClose }) {
  const row = (label, value) => h('div', { key: label, className: 'nodo-stats-row' },
    h('span', { className: 'nodo-stats-row-label' }, label),
    h('span', { className: 'nodo-stats-row-value' }, value))
  const billed = billedTokens(stats)
  const hit = cacheHitPercent(stats)
  const context = contextPercent(stats)
  return h(Modal, {
    open: true, onClose, closeLabel: '关闭', title: '会话统计', className: 'nodo-dialog',
    footer: [h(Button, { key: 'close', variant: 'primary', onClick: onClose }, '关闭')],
  },
  h('div', { className: 'nodo-dialog-fields' },
    h('div', { className: 'nodo-stats-section' },
      h('h3', { className: 'nodo-stats-heading' }, 'Token 用量'),
      row('未缓存输入', exactTokens(stats.inputTokens)),
      row('缓存读取', exactTokens(stats.cacheReadTokens)),
      row('缓存写入', exactTokens(stats.cacheWriteTokens)),
      row('输出', exactTokens(stats.outputTokens)),
      hit !== '' && row('缓存命中', `${hit}%`)),
    h('div', { className: 'nodo-stats-section' },
      h('h3', { className: 'nodo-stats-heading' }, '用时与速度'),
      row('轮次 / 步数', `${stats.turns} 轮 ${stats.steps} 步`),
      row('模型用时', compactDuration(stats.llmMs)),
      row('工具调用用时', compactDuration(stats.toolMs)),
      stats.ttftSteps > 0 && stats.ttftMs > 0 && row('首 token 平均（TTFT）', compactDuration(stats.ttftMs / stats.ttftSteps)),
      stats.decodeMs > 0 && stats.decodeTokens > 0 && row('输出速度（TPS）', `${tokensPerSecond(stats.decodeTokens, stats.decodeMs)} tok/s`),
      context !== null && row('上下文', `${exactTokens(stats.contextUsed)} / ${exactTokens(stats.contextSize)}（${context}%）`)),
    h('p', { className: 'nodo-dialog-hint' }, '只累计本会话的事件；Agent 没有上报的字段不显示，速度需要 Agent 以流式输出才测得到。')))
}

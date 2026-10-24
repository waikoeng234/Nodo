import { h, useState, useEffect, useRef, call, DisclosureRow, DiffBlock, CodeBlock, Button, IconCodeOutlineRegular, TerminalBlock } from './ui-shared.js'
import { TranscriptImage } from './feed.js'

export function supportedStreamRecord(value) {
  return value?.version === 1 && ['tool', 'changes'].includes(value.kind) && value.mode === 'snapshot' && value.body && typeof value.body === 'object'
    && !Array.isArray(value.body) && typeof value.runId === 'string' && typeof value.entityId === 'string'
    && Number.isSafeInteger(value.revision) && value.revision >= 0
}

const STREAM_STATUS = { running: '运行中', done: '已完成', error: '失败', denied: '已拒绝', interrupted: '已停止', unknown: '结果未确认' }
const STREAM_REASON = { unsupported: '当前内容格式尚不支持', 'source-limit': '来源内容超过保存上限', 'source-truncated': '来源仅提供部分内容',
  'detail-limit': '详情超过保存上限', quota: '此会话的详情存储已达上限', 'write-failed': '详情未能保存', 'read-only': '当前窗口无法保存新详情',
  conflict: '来源版本存在冲突', unconfirmed: 'Agent 未确认执行结果' }
const STREAM_CODE_LABELS = { copy: '复制', copied: '已复制' }
const STREAM_DIFF_LABELS = { ...STREAM_CODE_LABELS, collapseAria: '收起差异', expandAria: n => `展开其余 ${n} 行`, collapse: '收起', expand: n => `展开其余 ${n} 行` }
const STREAM_TERMINAL_LABELS = { ...STREAM_CODE_LABELS, signal: value => `信号 ${value}`, exitCode: value => `退出码 ${value}`, noExitCode: '退出码未知',
  running: '运行中', failed: '失败', done: '已完成', noOutput: '无输出', collapseAria: '收起输出', expandAria: n => `展开其余 ${n} 行`, collapse: '收起', expand: n => `展开其余 ${n} 行` }
const streamSize = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
const RESOURCE_LABELS = { image: '图片', file: '文件', link: '资源引用', audio: '音频', text: '嵌入文本资源' }
const RESOURCE_REASONS = { 'unsupported-type': '当前宿主不支持此内容类型', 'invalid-image': '图片来源数据无效，未保存', 'image-too-large': '图片超过保存上限，未保存',
  'storage-unavailable': '图片未能保存，仅保留来源信息', 'attachment-unavailable': '源附件不可读取', 'source-limit': '会话详情超过保存上限，图片未保存', 'no-reader': '宿主未提供读取或预览通道' }
// A saved image loads through the same attachment route as pasted images; a
// link is displayed but never fetched, and audio keeps no fake player.
export function ResourceItem({ resource }) {
  const label = RESOURCE_LABELS[resource.kind] ?? '资源'
  const meta = [resource.mimeType, Number.isFinite(resource.bytes) ? streamSize(resource.bytes) : null].filter(Boolean).join(' · ')
  const suffix = [resource.name, meta].filter(Boolean).join(' · ')
  if (resource.kind === 'image' && resource.state === 'stored' && resource.ref) {
    return h('div', { 'data-nodo-resource': 'image' },
      h(TranscriptImage, { image: { id: resource.ref.id, mediaType: resource.ref.mediaType, name: resource.name } }),
      h('p', { className: 'nodo-note' }, [label, suffix].filter(Boolean).join(' · ')))
  }
  if (resource.kind === 'image') {
    return h('p', { 'data-nodo-resource': 'image', className: 'nodo-note' },
      `${label}${suffix ? ` · ${suffix}` : ''}：${resource.state === 'pending' ? '工具结束后保存并展示。' : resource.reason === 'no-reader' ? '当前宿主无法验证图片，未保存。' : RESOURCE_REASONS[resource.reason] ?? '不可用。'}`)
  }
  if (resource.kind === 'audio') {
    return h('p', { 'data-nodo-resource': 'audio', className: 'nodo-note' },
      `${label}${suffix ? ` · ${suffix}` : ''}：当前宿主不支持音频播放，仅保留资源信息。`)
  }
  if (resource.kind === 'link') {
    return h('div', { 'data-nodo-resource': 'link', className: 'nodo-io-section' },
      h('span', { className: 'nodo-io-label' }, label),
      h('span', { className: 'nodo-io-text' }, [resource.name, resource.uri, meta].filter(Boolean).join(' · ')))
  }
  if (resource.kind === 'text') {
    return h('p', { 'data-nodo-resource': 'text', className: 'nodo-note' },
      `${label}${suffix ? ` · ${suffix}` : ''}：内容已并入输出文本。`)
  }
  return h('p', { 'data-nodo-resource': 'file', className: 'nodo-note' },
    `${label}${suffix ? ` · ${suffix}` : ''}：${RESOURCE_REASONS[resource.reason] ?? '仅保留引用。'}`)
}
export function ResourceList({ resources }) {
  const items = Array.isArray(resources) ? resources.filter(resource => resource && typeof resource === 'object' && typeof resource.kind === 'string') : []
  if (items.length === 0) return null
  return h('div', { 'data-nodo-resources': '' }, items.map((resource, index) => h(ResourceItem, { key: index, resource })))
}
function streamProgress(progress) {
  if (!progress || typeof progress !== 'object') return null
  const parts = []
  if (Number.isFinite(progress.elapsedMs)) parts.push(`已用时 ${(progress.elapsedMs / 1000).toFixed(1)} 秒`)
  if (typeof progress.message === 'string' && progress.message !== '') parts.push(progress.message.slice(0, 200))
  if (Number.isFinite(progress.outputBytes)) parts.push(`输出 ${streamSize(progress.outputBytes)}`)
  if (Number.isFinite(progress.stdoutBytes)) parts.push(`stdout ${streamSize(progress.stdoutBytes)}`)
  if (Number.isFinite(progress.stderrBytes)) parts.push(`stderr ${streamSize(progress.stderrBytes)}`)
  return parts.length ? parts.join(' · ') : null
}

export function ChangedFile({ file, load, loaded, available, root, request }) {
  const [open, setOpen] = useState(false)
  const [content, setContent] = useState(null)
  const [busy, setBusy] = useState(false)
  const path = root && file.path.startsWith(`${root}/`) ? file.path.slice(root.length + 1) : file.path
  const toggle = async () => {
    if (!open && !loaded && available && !await load()) return
    setOpen(value => !value)
  }
  const viewContent = async () => {
    if (busy) return
    setBusy(true)
    try { setContent(await call('workspace-file', { ...request, path: file.path })) }
    catch (failure) { setContent({ error: failure.message || '文件内容读取失败。' }) }
    finally { setBusy(false) }
  }
  const edits = file.edits.map((edit, index) => h('div', { key: index },
    h('p', { className: 'nodo-note' }, ({ add: '新增', update: '修改', delete: '删除', move: '移动', unknown: '编辑' })[edit.operation], edit.fromPath ? ` · 来自 ${edit.fromPath}` : ''),
    edit.availability && h('p', { className: 'nodo-note' }, ({ binary: '二进制文件，来源不提供文本差异。', oversized: '文件超过来源大小上限，差异不可得。', coarse: '来源比较超时，以下为整段替换的粗略差异。', unavailable: '来源未能提供此文件的差异。' })[edit.availability]),
    typeof edit.newText === 'string' && (typeof edit.oldText === 'string' || edit.oldText === null && edit.operation === 'add')
      ? h(DiffBlock, { diffs: [{ path, oldText: edit.oldText, newText: edit.newText }], labels: STREAM_DIFF_LABELS })
      : typeof edit.diffText === 'string' ? h(CodeBlock, { code: edit.diffText, lang: 'diff', copyLabel: '复制', copiedLabel: '已复制' })
        : typeof edit.newText === 'string' ? h('div', null, h('p', { className: 'nodo-note' }, '来源未提供修改前内容，以下为修改后内容。'),
          h(CodeBlock, { code: edit.newText, copyLabel: '复制', copiedLabel: '已复制' }))
          : h('p', { className: 'nodo-note' }, '此编辑的差异详情不可得。')))
  const view = request && h('div', { 'data-nodo-file-view': '' },
    h(Button, { size: 'sm', variant: 'outline', disabled: busy, onClick: () => void viewContent() }, busy ? '读取中…' : '查看当前内容'),
    content?.error && h('p', { role: 'alert', className: 'nodo-error-line' }, content.error),
    content?.missing && h('p', { className: 'nodo-note' }, '文件已不存在或不是普通文件。'),
    content?.binary && h('p', { className: 'nodo-note' }, '二进制文件，无法作为文本展示。'),
    typeof content?.text === 'string' && h('div', null,
      content.truncated && h('p', { className: 'nodo-note' }, '文件超过展示上限，仅显示开头部分。'),
      h(CodeBlock, { code: content.text, copyLabel: '复制', copiedLabel: '已复制' })))
  return h(DisclosureRow, { title: path, open, expandable: true, expandOnRowClick: true, keepContentWhenOpen: true, onToggle: () => void toggle(),
    children: h('div', null, edits, view) })
}

export function FileChangesContent({ value, record, full, load, busy, available, request }) {
  const [expanded, setExpanded] = useState(false)
  useEffect(() => setExpanded(false), [record.runId, record.entityId, record.revision])
  const files = Array.isArray(value.body.files) ? value.body.files : []
  const count = record.body.fileCount
  const toggle = async () => {
    if (!expanded && files.length < count && !full) { if (!available || !await load()) return }
    setExpanded(current => !current)
  }
  return h('div', { 'data-nodo-changes': '' },
    h('p', { className: 'nodo-note' }, value.body.scope === 'workspace-snapshot'
      ? '来自宿主工作区快照，可能包含其他会话或进程的修改；受忽略规则和文件上限限制，不能据此归因于当前 Agent。'
      : '仅覆盖 Agent 确认完成的编辑工具；可能遗漏命令或其他来源写入。以下按编辑记录展示，不代表本轮净差异。'),
    count === 0 && h('p', { className: 'nodo-note' }, value.body.scope === 'workspace-snapshot' ? '宿主汇总未列出文件，不能据此判断本轮没有文件变更。' : '未收到已确认的编辑文件，不能据此判断本轮没有文件变更。'),
    (expanded ? files : files.slice(0, 3)).map(file => h(ChangedFile, { key: file.path, file, load, loaded: Boolean(full), available, root: value.body.cwd, request })),
    count > 3 && h(Button, { size: 'sm', variant: 'outline', disabled: busy || !expanded && files.length < count && !available, onClick: () => void toggle() },
      expanded ? '收起文件列表' : `展开其余 ${count - 3} 项`),
    (full || !available) && files.length < count && h('p', { className: 'nodo-note' }, `仅保存了 ${files.length} / ${count} 项，其余内容不可得。`),
    typeof value.body.turnDiff === 'string' && h('div', null, h('p', { className: 'nodo-note' }, 'Agent 提供的轮次差异文本（文件列表仍为部分覆盖）。'),
      h(CodeBlock, { code: value.body.turnDiff, lang: 'diff', copyLabel: '复制', copiedLabel: '已复制' })))
}

export function StreamRecordCard({ record, request }) {
  const [open, setOpen] = useState(false)
  const [full, setFull] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  useEffect(() => {
    generation.current += 1
    setFull(null); setError(''); setBusy(false)
    return () => { generation.current += 1 }
  }, [record.runId, record.entityId, record.revision, request.profile, request.session, request.target])
  const load = async () => {
    const current = generation.current
    setBusy(true); setError('')
    try {
      const value = await call('stream-detail', { ...request, ref: record.details.ref })
      if (!supportedStreamRecord(value) || value.runId !== record.runId || value.entityId !== record.entityId || value.revision !== record.revision) throw new Error('工具详情版本不匹配。')
      if (generation.current === current) setFull(value)
      return generation.current === current ? value : null
    } catch (failure) { if (generation.current === current) setError(failure.message || '工具详情读取失败。') }
    finally { if (generation.current === current) setBusy(false) }
  }
  const value = full ?? record
  const body = value.body
  const failed = ['error', 'denied', 'unknown'].includes(record.status)
  const available = ['stored', 'truncated'].includes(record.details?.state) && record.details?.ref
  const status = STREAM_STATUS[record.status] ?? STREAM_STATUS.unknown
  const notice = record.capture !== 'complete' ? STREAM_REASON[record.reason] ?? '来源内容不完整' : null
  const progress = record.status === 'running' ? streamProgress(body.progress) : null
  const terminal = typeof body.command === 'string'
  const diffs = Array.isArray(body.diffs) ? body.diffs.filter(diff => typeof diff.path === 'string' && typeof diff.newText === 'string'
    && (typeof diff.oldText === 'string' || diff.oldText === null && diff.created === true)) : []
  return h('div', { 'data-nodo-stream-record': record.entityId, 'data-record-status': record.status },
    h(DisclosureRow, {
      icon: h(IconCodeOutlineRegular, { size: 14 }), title: record.kind === 'changes' ? `${record.body.scope === 'workspace-snapshot' ? '宿主工作区变更' : '已确认的编辑文件'} ${record.body.fileCount} · 部分覆盖` : record.title || '工具', open, expandable: true,
      running: record.status === 'running', expandOnRowClick: true, keepContentWhenOpen: true,
      onToggle: () => setOpen(value => !value),
      collapsedContent: record.kind === 'changes' ? null : h('span', { className: 'nodo-row-summary', 'data-error': failed ? '' : undefined }, status),
      children: h('div', { className: 'nodo-stream-content' },
        record.kind !== 'changes' && h('p', { className: 'nodo-note', 'data-error': failed ? '' : undefined }, status),
        progress && h('p', { className: 'nodo-note', 'data-nodo-progress': '' }, progress),
        notice && h('p', { className: 'nodo-note' }, notice),
        !full && record.truncated && h('p', { className: 'nodo-note' }, '当前显示摘要。'),
        record.kind !== 'changes' && h(ResourceList, { resources: body.resources }),
        record.kind === 'changes' ? h(FileChangesContent, { value, record, full, load, busy, available, request }) : terminal ? h(TerminalBlock, { command: body.command, cwd: body.cwd, output: body.outputText,
          exitCode: body.exitCode, signal: body.signal, running: record.status === 'running', runStateDot: false, labels: STREAM_TERMINAL_LABELS })
          : h('div', { className: 'nodo-io-card' }, [['输入', body.inputText ?? (body.input !== undefined ? JSON.stringify(body.input, null, 2) : '')], ['输出', body.outputText]]
            .filter(([, text]) => text).map(([label, text]) => h('div', { key: label, className: 'nodo-io-section' },
              h('span', { className: 'nodo-io-label' }, label), h('span', { className: 'nodo-io-text', 'data-error': failed && label === '输出' ? '' : undefined }, text)))),
        diffs.length > 0 && h(DiffBlock, { diffs, labels: STREAM_DIFF_LABELS }),
        record.status === 'running' && body.progress?.outputPreview && h('div', { className: 'nodo-io-section' },
          h('span', { className: 'nodo-io-label' }, '输出预览'), h('span', { className: 'nodo-io-text' }, body.progress.outputPreview)),
        record.status === 'running' && body.progress?.stdoutTail && h('div', { className: 'nodo-io-section' },
          h('span', { className: 'nodo-io-label' }, 'stdout（尾部）'), h('span', { className: 'nodo-io-text' }, body.progress.stdoutTail)),
        record.status === 'running' && body.progress?.stderrTail && h('div', { className: 'nodo-io-section' },
          h('span', { className: 'nodo-io-label' }, 'stderr（尾部）'), h('span', { className: 'nodo-io-text' }, body.progress.stderrTail)),
        available && !full && h(Button, { size: 'sm', variant: 'outline', disabled: busy, onClick: () => void load() }, busy ? '加载中…'
          : record.capture === 'complete' && record.details.state === 'stored' ? '查看完整详情' : '查看已保存详情'),
        full && h('p', { className: 'nodo-note' }, '已加载保存的详情。'),
        !available && record.status !== 'running' && h('p', { className: 'nodo-note' }, STREAM_REASON[record.details?.reason] ?? '详情不可用。'),
        error && h('p', { role: 'alert', className: 'nodo-error-line' }, error)),
    }))
}

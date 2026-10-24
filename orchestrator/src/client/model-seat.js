import { h, useState, useSyncExternalStore, Menu, StateDot, IconChevronRightOutlineRegular, IconChevronDownOutlineRegular, IconDataOutlineRegular } from './ui-shared.js'
import { modelName } from './feed.js'

// External engine catalogs belong to Nodo; native providers use the host directory.
export function createModelSeat(ctx, space) {
  function ModelSeat(props) {
    const { sessionId, locked } = props
    const available = typeof ctx.sessions?.subagentAddress !== 'function' || ctx.sessions.subagentAddress(sessionId) === undefined
    const directory = ctx.modelDirectories.directoryFor(sessionId)
    const state = useSyncExternalStore(directory.store.subscribe, directory.store.getSnapshot)
    const [open, setOpen] = useState(false)
    const [pane, setPane] = useState('root')
    const [error, setError] = useState('')
    if (!available) return null
    const close = () => { setOpen(false); setPane('root') }
    const openMenu = () => {
      if (open) return close()
      setOpen(true)
      void directory.load().catch(() => {})
    }
    const catalog = state
    const groups = (catalog?.groups ?? []).filter(group => group.models.length > 0)
    const current = catalog?.current ?? null
    const currentModel = groups.find(group => group.id === current?.provider)?.models.find(model => model.id === current?.model)
      ?? catalog?.groups.find(group => group.id === current?.provider)?.models.find(model => model.id === current?.model)
    const modelText = current ? currentModel?.name ?? modelName(current.model) : state?.status === 'ready' ? '选择模型' : '模型'
    const efforts = currentModel?.reasoning?.efforts ?? []
    const effortText = current?.reasoningEffort ? efforts.find(level => level.id === current.reasoningEffort)?.name ?? current.reasoningEffort : ''
    const busy = state?.status === 'loading' || state?.status === 'selecting'
    const select = selection => {
      setError('')
      // The menu stays open until the pick is accepted: a rejected selection
      // must be visible where it was made, not silently snap back to the
      // previous value after the menu closes.
      void directory.select(selection).then(() => close()).catch(failure => setError(failure.message))
    }
    const pick = id => {
      if (id === 'model') { setPane('model'); return }
      if (id === 'thinking') { setPane('thinking'); return }
      if (id.startsWith('model:')) {
        const [provider, model] = JSON.parse(id.slice(6))
        select({ provider, model })
      } else if (id.startsWith('thinking:')) {
        const level = id.slice(9)
        const selection = { provider: current.provider, model: current.model }
        if (level !== '') selection.reasoningEffort = level
        select(selection)
      }
    }
    const cell = (label, value, filled) => h('span', { className: 'nodo-model-cell' },
      h('span', { className: 'nodo-model-cell-label' }, label),
      h('span', { className: 'nodo-model-cell-value' }, value),
      filled && h('span', { className: 'nodo-model-cell-chev' }, h(IconChevronRightOutlineRegular, { size: 12 })))
    const items = pane === 'model'
      ? groups.length ? groups.flatMap(group => [
          { type: 'label', id: `group:${group.id}`, text: group.name },
          ...group.models.map(model => ({ id: `model:${JSON.stringify([group.id, model.id])}`, label: model.name })),
        ])
        : [{ type: 'label', id: 'hint', text: busy ? '正在载入模型目录…' : state?.error || '当前会话没有可用的模型' }]
      : pane === 'thinking'
        ? [{ id: 'thinking:', label: '默认（跟随模型设置）' },
          ...efforts.map(level => ({ id: `thinking:${level.id}`,
            label: level.id === currentModel?.reasoning?.defaultEffort ? `${level.name ?? level.id}（模型默认）` : level.name ?? level.id }))]
        : [
          ...(error ? [{ type: 'label', id: 'error', text: error }] : []),
          { id: 'model', label: cell('模型', modelText, groups.length > 0), disabled: !groups.length },
          { id: 'thinking', label: cell('推理等级', effortText || '默认', efforts.length > 0), disabled: !efforts.length },
        ]
    return h(Menu, {
      open, onClose: close, portal: true, side: 'top', align: 'end', className: 'nodo-model',
      listClassName: 'nodo-model-list',
      selectedId: pane === 'model' && current ? `model:${JSON.stringify([current.provider, current.model])}`
        : pane === 'thinking' && current?.reasoningEffort ? `thinking:${current.reasoningEffort}` : undefined,
      items, onSelect: pick,
      anchor: h('button', {
        type: 'button', className: 'nodo-model-trigger', disabled: locked === true || busy,
        'data-nodo-model-seat': 'true',
        'aria-haspopup': 'menu', 'aria-expanded': open,
        'aria-label': `选择模型，当前 ${modelText}${effortText ? `，推理等级 ${effortText}` : ''}`,
        onClick: openMenu,
      },
      h(IconDataOutlineRegular, { size: 16, className: 'nodo-model-seat-icon' }),
      h('span', { className: 'nodo-model-label' }, modelText),
      effortText !== '' && h('span', { className: 'nodo-model-effort' }, effortText),
      busy ? h(StateDot, { state: 'ongoing' }) : h('span', { className: 'nodo-chevron', 'data-open': open ? '' : undefined }, h(IconChevronDownOutlineRegular, { size: 14 }))),
    })
  }
  ctx.slots.inject('conversation.input.model', () => {
    let unregister
    const update = () => {
      const state = space.getSnapshot()
      if (state.active && !state.legacy && !unregister) unregister = ctx.slots.register({ name: 'conversation.input.model', priority: -100 }, ModelSeat)
      else if ((!state.active || state.legacy) && unregister) { unregister(); unregister = null }
    }
    const stop = space.subscribe(update)
    update()
    return () => { stop(); unregister?.() }
  })
  return { ModelSeat }
}

import type { RailRole, RailWorkspace } from './session-rail.tsx'
import {
  h, useState, useRef, useEffect, Modal, WorkDot, workLabel, workKind, sessionTime,
  IconBranchOutlineRegular, IconCloseOutlineRegular, IconFolderOpenOutlineRegular, IconSearchOutlineRegular,
} from './ui-shared.js'
import { RoleAvatar } from './avatar.tsx'

export interface SearchItem {
  id: string; role: RailRole; name: string; project: RailWorkspace; updatedAt?: number; work?: { active?: boolean }
  terms: (string | undefined)[]; pick: () => void
}
interface KeyEvent { key: string; keyCode?: number; preventDefault(): void; nativeEvent?: { isComposing?: boolean } }

// The session finder shared by the home and team rails: one list over every
// project, newest first, narrowed by what is typed.
export function SearchDialog({ items, onClose }: { items: SearchItem[]; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const list = useRef<HTMLDivElement | null>(null)
  const needle = query.trim().toLocaleLowerCase()
  const found = needle ? items.filter(item => item.terms.some(term => String(term ?? '').toLocaleLowerCase().includes(needle))) : items
  const current = Math.min(active, found.length - 1)
  const pick = (item: SearchItem) => { onClose(); item.pick() }
  useEffect(() => { (list.current?.children[current] as HTMLElement | undefined)?.scrollIntoView?.({ block: 'nearest' }) }, [current])
  const onKeyDown = (event: KeyEvent) => {
    if (event.nativeEvent?.isComposing || event.keyCode === 229) return
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
    if (step && found.length) { event.preventDefault(); setActive((current + step + found.length) % found.length) }
    else if (event.key === 'Enter' && found[current]) { event.preventDefault(); pick(found[current]) }
  }
  return (
    <Modal open onClose={onClose} closeLabel="关闭" title="搜索会话" headless className="nodo-search-dialog">
      <label className="nodo-search-box">
        <IconSearchOutlineRegular size={18} />
        <input type="search" data-modal-autofocus value={query} placeholder="搜索会话和项目" aria-label="搜索会话和项目"
          onChange={(event: { target: { value: string } }) => { setQuery(event.target.value); setActive(0) }} onKeyDown={onKeyDown} />
        <button type="button" className="nodo-icon-btn nodo-visible" aria-label="关闭搜索" onClick={onClose}><IconCloseOutlineRegular size={16} /></button>
      </label>
      <div className="nodo-search-list" role="listbox" aria-label="会话" ref={list}>
        {found.map((item, index) => {
          const on = index === current
          const status = workLabel(item.work)
          const Glyph = item.project.worktree ? IconBranchOutlineRegular : IconFolderOpenOutlineRegular
          return (
            <button key={item.id} type="button" role="option" className="nodo-search-row" aria-selected={on} data-active={on || undefined}
              title={`${item.role.name} · ${item.name}`} onMouseMove={() => { if (!on) setActive(index) }} onClick={() => pick(item)}>
              <span className="nodo-search-avatar" data-lead={item.role.lead === true ? '' : undefined}><RoleAvatar profile={item.role} size={20} /></span>
              <span className="nodo-search-name">{item.name}</span>
              <span className="nodo-search-project"><Glyph size={14} /><span>{item.project.name}</span></span>
              <span className="nodo-search-meta">{on ? '↵' : status
                ? <span className="nodo-row-running"><WorkDot kind={workKind(item.work)} />{status}</span>
                : sessionTime(item.updatedAt)}</span>
            </button>
          )
        })}
        {!found.length && <p className="nodo-rail-empty" role="status">{items.length ? '没有找到匹配的会话' : '暂无会话'}</p>}
      </div>
    </Modal>
  )
}

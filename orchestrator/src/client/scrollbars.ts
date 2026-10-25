// Scrollbars inside Nodo (its pages, and the whole window while the Nodo space
// is open) show only while their own element scrolls and fade once it rests.
// The host draws every thumb from --dsh-scrollbar-thumb; only its opacity moves.
const SCOPE = ':root[data-nodo-space], .nodo-page'
const IDLE_MS = 900

export const SCROLLBAR_CSS = `
@property --nodo-scroll-fade{syntax:'<number>';inherits:true;initial-value:0}
:where(:root[data-nodo-space],.nodo-page),:where(:root[data-nodo-space],.nodo-page) *{--nodo-scroll-fade:0;transition:--nodo-scroll-fade .6s var(--ds-ease-in-out)}
:where(:root[data-nodo-space],.nodo-page)[data-scrolling],:where(:root[data-nodo-space],.nodo-page) [data-scrolling]{--nodo-scroll-fade:1;transition-duration:.12s}
:is(:root[data-nodo-space],.nodo-page)::-webkit-scrollbar-thumb,:is(:root[data-nodo-space],.nodo-page) ::-webkit-scrollbar-thumb{background-color:color-mix(in srgb,var(--dsh-scrollbar-thumb) calc(var(--nodo-scroll-fade) * 100%),transparent)}
:is(:root[data-nodo-space],.nodo-page)::-webkit-scrollbar-thumb:hover,:is(:root[data-nodo-space],.nodo-page) ::-webkit-scrollbar-thumb:hover{background-color:var(--dsh-scrollbar-thumb-hover)}
`

export function installScrollbars(document: Document) {
  const timers = new Map<Element, ReturnType<typeof setTimeout>>()
  const rest = (element: Element) => { element.removeAttribute('data-scrolling'); timers.delete(element) }
  const onScroll = (event: Event) => {
    const element = event.target === document ? document.scrollingElement : event.target as Element | null
    if (!element?.closest?.(SCOPE)) return
    clearTimeout(timers.get(element))
    element.setAttribute('data-scrolling', '')
    timers.set(element, setTimeout(() => rest(element), IDLE_MS))
  }
  document.addEventListener('scroll', onScroll, { capture: true, passive: true })
  return () => {
    document.removeEventListener('scroll', onScroll, { capture: true })
    for (const [element, timer] of timers) { clearTimeout(timer); rest(element) }
  }
}

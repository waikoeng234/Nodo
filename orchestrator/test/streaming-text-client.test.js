import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './helpers/client-module.js'

function fixture({ highlight = true, reduced = false } = {}) {
  const highlights = new Map(), frames = new Map(), styles = [], observers = []
  let now = 0, serial = 0
  const view = {
    CSS: { highlights: highlight ? highlights : undefined },
    Highlight: class { constructor(range) { this.range = range } },
    performance: { now: () => now },
    matchMedia: () => ({ matches: reduced }),
    getComputedStyle: () => ({ color: 'rgb(20, 20, 20)' }),
    requestAnimationFrame: callback => { frames.set(++serial, callback); return serial },
    cancelAnimationFrame: id => frames.delete(id),
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this) }
      observe() {}
      disconnect() { this.disconnected = true }
    },
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this) }
      observe() {}
      disconnect() { this.disconnected = true }
    },
  }
  const document = {
    defaultView: view,
    head: { appendChild: style => styles.push(style) },
    createElement: () => ({ textContent: '', remove() { styles.splice(styles.indexOf(this), 1) } }),
    createTreeWalker(root) {
      let index = 0
      return { nextNode: () => root.nodes[index++] ?? null }
    },
    createRange: () => ({
      setStart(node, offset) { this.startContainer = node; this.startOffset = offset },
      setEnd(node, offset) { this.endContainer = node; this.endOffset = offset },
      collapse() {},
      getBoundingClientRect: () => ({ left: 70, top: 40, height: 24 }),
    }),
  }
  const root = { ownerDocument: document, nodes: [], parentElement: { getBoundingClientRect: () => ({ left: 10, top: 20 }) } }
  const caret = { hidden: true, style: {} }
  const paragraph = {}
  const append = (text, { block = paragraph, ignored = false } = {}) => {
    const node = { data: text, parentElement: { closest: selector => selector.startsWith('button') ? ignored : block } }
    root.nodes.push(node)
    return node
  }
  return { root, caret, append, highlights, frames, styles, observers,
    update() { observers.filter(observer => !observer.disconnected).forEach(observer => observer.callback()) },
    tick(time) { now = time; const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(time)) },
    highlighted: () => [...highlights.values()].map(({ range }) => range.startContainer === range.endContainer
      ? range.startContainer.data.slice(range.startOffset, range.endOffset) : '<cross-inline>'),
  }
}

test('word segmentation preserves English, Chinese, whitespace, punctuation and inline Markdown boundaries', async () => {
  const { streamingWords } = await loadClient('streaming-text.tsx')
  const f = fixture()
  f.append('你好，  streaming')
  f.append('Text\nworks! 👩🏽‍💻')
  f.append('复制代码', { ignored: true })
  f.append('Another paragraph', { block: {} })
  const parsed = streamingWords(f.root)
  const words = Array.from(parsed.words, word => word.segment)
  assert.ok(words.includes('你好'))
  assert.ok(words.includes('streamingText'), 'inline styling does not split an English word')
  assert.ok(words.includes('works'))
  assert.ok(words.includes('Another'), 'block boundaries do not merge adjacent words')
  assert.ok(!words.includes('复制'), 'hidden/control text does not receive highlights')
  assert.ok(words.every(word => !/[，!\s]/u.test(word)))
  assert.equal(f.root.nodes.map(node => node.data).join(''), '你好，  streamingText\nworks! 👩🏽‍💻复制代码Another paragraph')
  assert.equal(parsed.nodes[1].start, '你好，  streaming'.length)
})

const opacity = f => (f.styles[0]?.textContent ?? '').split('\n').filter(Boolean)
  .map(rule => Number(rule.match(/ ([0-9.]+)%,transparent/)[1]))

test('every newly received word fades in with a bounded stagger, including punctuation, without rewriting Markdown nodes', async () => {
  const { decorateStreamingText } = await loadClient('streaming-text.tsx')
  const f = fixture()
  const node = f.append('你好，hello world!  \n')
  const decoration = decorateStreamingText(f.root, f.caret, { name: 'batch', streaming: true })
  assert.deepEqual(f.highlighted(), ['你好，', 'hello ', 'world!  \n'])
  assert.deepEqual(opacity(f), [0, 0, 0])
  assert.equal(f.frames.size, 1)
  assert.equal(f.caret.hidden, false)
  assert.deepEqual(f.caret.style, { left: '60px', top: '20px', height: '24px' })
  f.tick(80)
  const values = opacity(f)
  assert.ok(values.every(value => value > 0 && value < 100))
  assert.ok(values[0] > values[1] && values[1] > values[2], 'a batch enters as a wave rather than becoming opaque together')
  f.tick(600)
  assert.equal(f.highlights.size, 0)
  assert.equal(f.frames.size, 0)
  assert.equal(f.styles.length, 0)
  assert.equal(node.data, '你好，hello world!  \n')
  decoration.dispose()
})

test('later batches retain the previous fade progress and settled words never replay', async () => {
  const { decorateStreamingText } = await loadClient('streaming-text.tsx')
  const f = fixture()
  const node = f.append('hello world')
  const decoration = decorateStreamingText(f.root, f.caret, { name: 'continuous', streaming: true })
  f.tick(100)
  const previousRule = f.styles[0].textContent.split('\n')[0]
  node.data += ' again now'
  f.update()
  assert.equal(f.styles.length, 1, 'one stylesheet survives content updates')
  assert.equal(f.styles[0].textContent.split('\n')[0], previousRule, 'new text does not reset existing word opacity')
  assert.ok(f.highlighted().includes('again '))
  assert.ok(f.highlighted().includes('now'))
  f.tick(350)
  assert.deepEqual(f.highlighted(), ['again ', 'now'])
  f.tick(700)
  assert.equal(f.highlights.size, 0)
  f.update()
  assert.equal(f.frames.size, 0)
  assert.equal(f.highlights.size, 0)
  decoration.dispose()
})

test('large batches finish their entrance promptly instead of accumulating a word-by-word playback queue', async () => {
  const { decorateStreamingText } = await loadClient('streaming-text.tsx')
  const f = fixture()
  const text = Array.from({ length: 80 }, (_, i) => 'word' + i).join(' ')
  const node = f.append(text)
  const decoration = decorateStreamingText(f.root, f.caret, { name: 'large', streaming: true })
  assert.equal(f.highlights.size, 80)
  f.tick(200)
  assert.equal(opacity(f).length, 80)
  assert.ok(opacity(f).every(value => value > 0), 'even the last word has started appearing')
  f.tick(600)
  assert.equal(f.highlights.size, 0)
  assert.equal(node.data, text)
  decoration.dispose()
})

test('completion hides the caret while the same in-flight entrance finishes naturally', async () => {
  const { decorateStreamingText } = await loadClient('streaming-text.tsx')
  const f = fixture()
  f.append('中文 English，完成。')
  const decoration = decorateStreamingText(f.root, f.caret, { name: 'done', streaming: true })
  f.tick(90)
  const before = f.styles[0].textContent
  decoration.update(false)
  assert.equal(f.caret.hidden, true)
  assert.equal(f.styles[0].textContent, before)
  assert.ok(f.highlights.size > 0)
  assert.equal(f.frames.size, 1)
  f.tick(600)
  assert.equal(f.highlights.size, 0)
  assert.equal(f.styles.length, 0)
  decoration.dispose()
})

test('extending a partial word fades only its new suffix and preserves the prefix animation', async () => {
  const { decorateStreamingText } = await loadClient('streaming-text.tsx')
  const f = fixture()
  const node = f.append('收到 hel')
  const decoration = decorateStreamingText(f.root, f.caret, { name: 'partial', streaming: true })
  f.tick(80)
  const before = f.styles[0].textContent.split('\n').find(rule => rule.includes('partial-3-6'))
  node.data += 'lo'
  f.update()
  assert.ok(f.highlighted().includes('hel'))
  assert.ok(f.highlighted().includes('lo'))
  assert.equal(f.styles[0].textContent.split('\n').find(rule => rule.includes('partial-3-6')), before)
  assert.equal(node.data, '收到 hello')
  decoration.dispose()
})

test('authoritative text replacement drops obsolete ranges without retaining removed text in the displayed DOM', async () => {
  const { decorateStreamingText } = await loadClient('streaming-text.tsx')
  const f = fixture()
  const node = f.append('obsolete words')
  const decoration = decorateStreamingText(f.root, f.caret, { name: 'replacement', streaming: true })
  node.data = 'corrected text'
  f.update()
  assert.deepEqual(f.highlighted(), ['corrected ', 'text'])
  assert.equal(node.data, 'corrected text')
  decoration.dispose()
})

test('ranges span inline Markdown nodes and independent mounted messages clean up separately', async () => {
  const { decorateStreamingText } = await loadClient('streaming-text.tsx')
  const f = fixture()
  f.append('hel'); f.append('lo')
  const first = decorateStreamingText(f.root, f.caret, { name: 'one', streaming: true })
  const second = decorateStreamingText(f.root, f.caret, { name: 'two', streaming: true })
  assert.deepEqual(f.highlighted(), ['<cross-inline>', '<cross-inline>'])
  first.dispose()
  assert.equal(f.highlights.size, 1)
  assert.ok([...f.highlights.keys()].every(key => key.startsWith('two-')))
  second.dispose()
  assert.equal(f.highlights.size, 0)
  assert.equal(f.frames.size, 0)
  assert.equal(f.styles.length, 0)
  assert.ok(f.observers.every(observer => observer.disconnected))
})

test('history stays immediately readable and a newly completed message can animate without a running state', async () => {
  const { decorateStreamingText } = await loadClient('streaming-text.tsx')
  const f = fixture()
  const node = f.append('historical text')
  const decoration = decorateStreamingText(f.root, f.caret, { name: 'history', streaming: false })
  assert.equal(f.frames.size, 0)
  assert.equal(f.highlights.size, 0)
  node.data += ' fresh answer'
  decoration.update(false, true)
  assert.deepEqual(f.highlighted(), ['fresh ', 'answer'])
  assert.equal(f.caret.hidden, true)
  decoration.dispose()
})

test('reduced motion and unsupported Highlight API keep content visible without animation frames', async () => {
  const { decorateStreamingText } = await loadClient('streaming-text.tsx')
  for (const options of [{ reduced: true }, { highlight: false }]) {
    const f = fixture(options)
    const node = f.append('Hello 世界，👩🏽‍💻')
    const decoration = decorateStreamingText(f.root, f.caret, { name: 'fallback', streaming: true })
    assert.equal(f.highlights.size, 0)
    assert.equal(f.frames.size, 0)
    assert.equal(f.styles.length, 0)
    assert.equal(node.data, 'Hello 世界，👩🏽‍💻')
    decoration.update(false)
    assert.equal(f.caret.hidden, true)
    decoration.dispose()
  }
})

test('StreamingText retains one decoration through renders and completion and cleans it up on unmount', async () => {
  const f = fixture(), refs = [], effects = []
  let refCursor = 0, effectCursor = 0, pending = []
  const { StreamingText } = await loadClient('streaming-text.tsx', { react: {
    useRef: initial => refs[refCursor++] ??= { current: initial },
    useLayoutEffect: (effect, deps) => {
      const at = effectCursor++, previous = effects[at]
      if (!previous || deps.some((value, index) => !Object.is(value, previous.deps[index]))) {
        pending.push(() => { previous?.cleanup?.(); effects[at] = { deps, cleanup: effect() } })
      }
    },
  } })
  const text = '**你好**，hello\n\n```js\nconst a = 1\n```'
  const labels = { copy: 'Copy' }
  const node = f.append('你好，hello')
  const render = (value, streaming) => {
    refCursor = 0; effectCursor = 0; pending = []
    const tree = StreamingText({ text: value, streaming, labels, variant: 'compact' })
    tree.children[0].props.ref.current = f.root
    tree.children[1].props.ref.current = f.caret
    pending.forEach(effect => effect())
    return tree
  }
  render(text, false)
  assert.equal(refs[2].current, null)
  assert.equal(f.observers.length, 0, 'static history does not allocate animation observers')
  let tree = render(text, true)
  const controller = refs[2].current
  const markdown = tree.children[0].children[0]
  assert.equal(markdown.type, 'MarkdownText')
  assert.equal(markdown.props.text, text, 'the complete Markdown source is never sliced into invalid fragments')
  assert.equal(markdown.props.streaming, true)
  assert.equal(markdown.props.labels, labels)
  assert.equal(markdown.props.variant, 'compact')
  assert.equal(tree.children[1].props['aria-hidden'], true)
  f.tick(70)
  node.data += ' world'
  tree = render(text + ' world', true)
  assert.equal(refs[2].current, controller)
  render(text + ' world', false)
  assert.equal(refs[2].current, controller)
  assert.equal(f.caret.hidden, true)
  assert.ok(f.highlights.size > 0, 'completion leaves the entrance mounted')
  effects.forEach(effect => effect.cleanup?.())
  assert.equal(f.frames.size, 0)
  assert.equal(f.highlights.size, 0)
  assert.equal(f.styles.length, 0)
  assert.ok(f.observers.every(observer => observer.disconnected))
})

test('the feed retains StreamingText for completed messages while the legacy buffer and reasoning still stream', async () => {
  const feed = { key: 'profile:session', lines: [{ who: 'agent', kind: 'text', text: '**Earlier reply**' }], error: '' }
  const { Feed, ProcessRow, StreamingText } = await loadClient(['feed.js', 'streaming-text.tsx'], {
    react: { useState: initial => [initial?.lines ? feed : initial, () => {}] },
  })
  const all = node => !node || typeof node !== 'object' ? [] : [node, ...[...(node.children ?? []), node.props.children].flat(Infinity).flatMap(all)]
  const props = { profile: { id: 'profile', name: 'Role' }, session: { id: 'session' }, work: { active: true, buffer: '你好 hello' } }
  const tree = all(Feed(props))
  const live = tree.find(node => node.type === StreamingText && node.props.streaming)
  const historical = tree.find(node => node.type === StreamingText && !node.props.streaming)
  assert.equal(live.props.text, '你好 hello')
  assert.equal(historical.props.text, '**Earlier reply**')
  assert.equal(historical.props.animate, false)
  const finished = all(Feed({ ...props, work: { active: false, buffer: 'stale' } })).filter(node => node.type === StreamingText)
  assert.equal(finished.length, 1)
  assert.equal(finished[0].props.streaming, false)
  const reasoning = all(ProcessRow({ kind: 'thinking', title: '思考', body: '**思考** in English', running: true, variant: { icon: () => null } }))
  const body = reasoning.find(node => node.type === StreamingText)
  assert.equal(body.props.text, '**思考** in English')
  assert.equal(body.props.streaming, true)
  assert.equal(body.props.variant, 'compact')
})


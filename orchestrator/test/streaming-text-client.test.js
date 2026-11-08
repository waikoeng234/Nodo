
// Feed reads its lines from the shared store; tests seed it with this stub.
const liveStub = feed => ({
  transcriptOf: key => feed.lines, transcriptError: () => feed.error ?? '',
  pullTranscript: async () => {}, watchTranscript: () => () => {}, subscribeStore: () => () => {}, getStoreVersion: () => 0,
})
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
  const { StreamingText } = await loadClient('streaming-text.tsx', { primitives: { useMarkdownDelegate: () => ({}) }, react: {
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
    stubs: { 'live.js': liveStub(feed) },
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


test('reply file references link only to readable workspace files, are checked once, and open in the right panel', async () => {
  const opened = [], requests = []
  let target = { workspace: 'w', cwd: '/ws' }
  const refs = []
  let refCursor = 0
  const { StreamingText, codeFilePath, host } = await loadClient('streaming-text.tsx', {
    primitives: { useMarkdownDelegate: () => ({}) },
    react: { useRef: initial => refs[refCursor++] ??= { current: initial } },
    uiShared: {
      rightPanelService: { subscribe: () => () => {}, getSnapshot: () => ({ target }), openFile: path => opened.push(path) },
      call: async (endpoint, payload) => {
        requests.push([endpoint, payload.workspace, payload.path])
        return payload.path.includes('missing') ? { missing: true } : payload.path.endsWith('.bin') ? { binary: true } : { text: '' }
      },
    },
  })
  assert.equal(codeFilePath('orchestrator/index.js:12'), 'orchestrator/index.js')
  assert.equal(codeFilePath('README.md'), 'README.md')
  for (const text of ['npm test', 'v1.2', 'src/', 'https://a.b/c.js', 'fn()', '~/x.ts', 'value']) assert.equal(codeFilePath(text), undefined, text)
  const find = (node, type) => !node || typeof node !== 'object' ? undefined
    : node.type === type ? node : node.children?.map(child => find(child, type)).find(Boolean)
  const render = (props = {}) => { host.reset(); refCursor = 0; return StreamingText({ text: 'x', labels: {}, ...props }) }
  let tree = render()
  host.effects.splice(0).forEach(effect => effect())
  let mentions = find(tree, 'MarkdownText').props.fileMentions
  let delegate = find(tree, 'MarkdownDelegateProvider').props
  assert.equal(mentions.resolve('src/a.ts:12'), undefined, 'unchecked paths stay plain')
  assert.equal(mentions.resolve('src/missing.ts'), undefined)
  assert.equal(mentions.resolve('out/app.bin'), undefined)
  assert.equal(mentions.resolve('npm test'), undefined)
  assert.equal(delegate.getTriggerProps({ kind: 'file', path: '/ws/docs/b.md' }).disabled, true, 'unchecked Markdown file links render as plain text')
  assert.equal(delegate.getTriggerProps({ kind: 'url', url: 'https://a.b' }), undefined)
  await new Promise(resolve => setImmediate(resolve))
  tree = render()
  tree = render()
  mentions = find(tree, 'MarkdownText').props.fileMentions
  delegate = find(tree, 'MarkdownDelegateProvider').props
  const mention = mentions.resolve('src/a.ts:12')
  assert.equal(mention.title, 'src/a.ts')
  assert.equal(mention.contextMenuProps['data-nodo-file'], '', 'linked text stays in the streaming decoration text')
  mention.open()
  assert.equal(mentions.resolve('src/missing.ts'), undefined)
  assert.equal(mentions.resolve('out/app.bin'), undefined)
  const linked = delegate.getTriggerProps({ kind: 'file', path: '/ws/docs/b.md' })
  assert.equal(linked.disabled, undefined)
  assert.equal(linked['data-nodo-file'], '')
  delegate.openFile('/ws/docs/b.md')
  assert.deepEqual(opened, ['src/a.ts', 'docs/b.md'], 'paths inside the workspace open relative so the tree selects them')
  assert.deepEqual(requests.sort(), [['workspace-file', 'w', '/ws/docs/b.md'], ['workspace-file', 'w', 'out/app.bin'], ['workspace-file', 'w', 'src/a.ts'], ['workspace-file', 'w', 'src/missing.ts']],
    'each path is checked once across renders')
  target = null
  tree = render({ streaming: true })
  assert.equal(find(tree, 'MarkdownDelegateProvider'), undefined, 'without a right panel target nothing links')
  assert.equal(find(tree, 'MarkdownText').props.fileMentions, undefined)
})

// 每个 mount 用独立的 ref 表模拟一条新消息；返回当前实例的 fileMentions 和 delegate。
async function fileLinkClient(handler) {
  const requests = [], instances = [], opened = []
  let refs, refCursor = 0, target = { workspace: 'w', cwd: '/ws' }
  const client = await loadClient('streaming-text.tsx', {
    primitives: { useMarkdownDelegate: () => ({}) },
    react: { useRef: initial => refs[refCursor++] ??= { current: initial } },
    uiShared: {
      rightPanelService: { subscribe: () => () => {}, getSnapshot: () => ({ target }), openFile: path => opened.push(path) },
      call: async (endpoint, payload) => { requests.push([payload.workspace, payload.path ?? payload.query, endpoint]); return handler(payload.path, endpoint, payload) },
    },
  })
  const find = (node, type) => !node || typeof node !== 'object' ? undefined
    : node.type === type ? node : node.children?.map(child => find(child, type)).find(Boolean)
  const render = instance => {
    refs = instances[instance] ??= []
    client.host.reset(); refCursor = 0
    const tree = client.StreamingText({ text: 'x', labels: {} })
    client.host.effects.splice(0).forEach(effect => effect())
    return { mentions: find(tree, 'MarkdownText').props.fileMentions, delegate: find(tree, 'MarkdownDelegateProvider').props }
  }
  return { ...client, requests, opened, render, settle: () => new Promise(resolve => setImmediate(resolve)), setTarget: value => { target = value } }
}

test('missing or failed file checks are retried by later messages, but not repeated within one message', async () => {
  let created = false, down = true
  const { render, requests, settle } = await fileLinkClient(async path => {
    if (path === 'src/new.ts') return created ? { text: '' } : { missing: true }
    if (down) throw new Error('offline')
    return { text: '' }
  })
  assert.equal(render(0).mentions.resolve('src/new.ts'), undefined)
  assert.equal(render(0).mentions.resolve('src/flaky.ts'), undefined)
  await settle()
  assert.equal(render(0).mentions.resolve('src/new.ts'), undefined)
  assert.equal(render(0).mentions.resolve('src/flaky.ts'), undefined)
  await settle()
  assert.equal(requests.length, 2, 'streaming renders of one message do not re-request a path')
  created = true; down = false
  render(1).mentions.resolve('src/new.ts')
  render(1).mentions.resolve('src/flaky.ts')
  await settle()
  assert.ok(render(1).mentions.resolve('src/new.ts'), 'a file created after an earlier mention links in a later message')
  assert.ok(render(1).mentions.resolve('src/flaky.ts'), 'a failed request is not cached as missing')
  assert.ok(render(2).mentions.resolve('src/new.ts'), 'found files stay cached globally')
  assert.equal(requests.length, 4)
})

test('file checks are keyed by working directory', async () => {
  const { render, requests, settle, setTarget } = await fileLinkClient(async () => ({ text: '' }))
  render(0).mentions.resolve('src/a.ts')
  await settle()
  assert.ok(render(0).mentions.resolve('src/a.ts'))
  setTarget({ workspace: 'w', cwd: '/other' })
  assert.equal(render(0).mentions.resolve('src/a.ts'), undefined, 'a hit in one cwd does not link the same relative path in another')
  await settle()
  assert.ok(render(0).mentions.resolve('src/a.ts'))
  assert.equal(requests.length, 2)
})

test('a bare file name links when exactly one workspace file has that name, opening its full relative path', async () => {
  const files = { 'client.js': ['orchestrator/client.js', 'orchestrator/client.json'], 'index.js': ['a/index.js', 'b/index.js'], 'ghost.js': [], 'blob.bin': ['out/blob.bin'] }
  const { render, requests, opened, settle } = await fileLinkClient(async (path, endpoint, payload) =>
    endpoint === 'workspace-files' ? { files: files[payload.query] } : path === 'out/blob.bin' || !path.includes('/') ? { missing: true } : { text: '' })
  for (const name of ['client.js', 'index.js', 'ghost.js', 'blob.bin']) assert.equal(render(0).mentions.resolve(name), undefined, name)
  render(0).delegate.getTriggerProps({ kind: 'file', path: 'client.js' })
  await settle()
  for (const name of ['client.js', 'index.js', 'ghost.js', 'blob.bin']) render(0).mentions.resolve(`${name}:3`)
  await settle()
  const { mentions, delegate } = render(0)
  const mention = mentions.resolve('client.js')
  assert.equal(mention.title, 'orchestrator/client.js')
  mention.open()
  assert.equal(delegate.getTriggerProps({ kind: 'file', path: 'client.js' }).disabled, undefined, 'Markdown links to a bare name share the same lookup')
  delegate.openFile('client.js')
  assert.deepEqual(opened, ['orchestrator/client.js', 'orchestrator/client.js'])
  assert.equal(mentions.resolve('index.js'), undefined, 'several files with the name stay plain')
  assert.equal(mentions.resolve('ghost.js'), undefined, 'no match stays plain')
  assert.equal(mentions.resolve('blob.bin'), undefined, 'an unreadable match stays plain')
  assert.deepEqual(requests.filter(item => item[2] === 'workspace-files').map(item => item[1]).sort(), ['blob.bin', 'client.js', 'ghost.js', 'index.js'],
    'each name is searched once per message')
})

test('a full page of name matches may be truncated, so the name stays plain', async () => {
  const files = ['a/index.ts', ...Array.from({ length: 29 }, (_, at) => `d${at}/index.tsx`)]
  const { render, requests, settle } = await fileLinkClient(async (path, endpoint) => endpoint === 'workspace-files' ? { files } : path.includes('/') ? { text: '' } : { missing: true })
  render(0).mentions.resolve('index.ts')
  for (let at = 0; at < 3; at += 1) await settle()
  assert.equal(render(0).mentions.resolve('index.ts'), undefined)
  assert.equal(requests.some(item => item[1] === 'a/index.ts'), false, 'a truncated result is never treated as the unique match')
})

test('text from another conversation renders without file links while the current one still links', async () => {
  const { render, StreamingText, host, settle } = await fileLinkClient(async () => ({ text: '' }))
  render(0).mentions.resolve('src/a.ts')
  await settle()
  assert.ok(render(0).mentions.resolve('src/a.ts'))
  host.reset()
  const tree = StreamingText({ text: 'x', labels: {}, fileLinks: false })
  const find = (node, type) => !node || typeof node !== 'object' ? undefined
    : node.type === type ? node : node.children?.map(child => find(child, type)).find(Boolean)
  assert.equal(find(tree, 'MarkdownDelegateProvider'), undefined)
  assert.equal(find(tree, 'MarkdownText').props.fileMentions, undefined)
  assert.equal(find(tree, 'MarkdownText').props.fileLinks, undefined, 'the switch is not forwarded to Markdown')
})

test('codeFilePath accepts common real paths and strips location suffixes, but skips ordinary words', async () => {
  const { codeFilePath } = await fileLinkClient(async () => ({}))
  for (const [text, path] of [
    ['Makefile', 'Makefile'], ['Dockerfile', 'Dockerfile'], ['LICENSE', 'LICENSE'], ['.gitignore', '.gitignore'],
    ['docs/a b.md', 'docs/a b.md'], ['src/app/[id]/page.tsx', 'src/app/[id]/page.tsx'], ['src/(auth)/login.ts', 'src/(auth)/login.ts'],
    ['src/a.ts#L12', 'src/a.ts'], ['src/a.ts#L12-L20', 'src/a.ts'], ['src/a.ts:12:5-10', 'src/a.ts'], ['src/a.ts:12-20', 'src/a.ts'], ['a.ts:12:5', 'a.ts'],
  ]) assert.equal(codeFilePath(text), path, text)
  for (const text of ['npm test', 'value', 'fn()', 'v1.2', 'https://a.b/c.js', 'src/', 'useState', 'StreamingText', 'a b.md', 'I', '~/x.ts', '{a}/b.ts'])
    assert.equal(codeFilePath(text), undefined, text)
})

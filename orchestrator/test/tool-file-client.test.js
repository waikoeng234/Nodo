import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './helpers/client-module.js'

test('file icons resolve name specials before extensions and fall back per format', async () => {
  const { fileIconKey } = await loadClient('file-icons.tsx')
  assert.equal(fileIconKey('app.tsx'), 'react_ts')
  assert.equal(fileIconKey('component.jsx'), 'react')
  assert.equal(fileIconKey('SCRIPT.JS'), 'javascript')
  assert.equal(fileIconKey('src/pkg/package.json'), 'npm')
  assert.equal(fileIconKey('Dockerfile'), 'docker')
  assert.equal(fileIconKey('.gitignore'), 'git')
  assert.equal(fileIconKey('README.md'), 'readme')
  assert.equal(fileIconKey('LICENSE'), 'license')
  assert.equal(fileIconKey('notes.txt'), 'document')
  assert.equal(fileIconKey('shot.PNG'), 'image')
  assert.equal(fileIconKey('bundle.tar.gz'), 'zip')
  assert.equal(fileIconKey('run.log'), 'log')
  assert.equal(fileIconKey('no-extension'), null)
  assert.equal(fileIconKey('archive.xyz'), null)
  const { FileIcon } = await loadClient('file-icons.tsx')
  const icon = FileIcon({ name: 'a.ts' })
  assert.equal(icon.type, 'img')
  assert.match(icon.props.src, /^data:image\/svg\+xml;base64,/)
  assert.equal(icon.props.alt, '')
  const fallback = FileIcon({ name: 'a.xyz' })
  assert.equal(fallback.type, 'IconPaperclipOutlineRegular')
  const custom = FileIcon({ name: 'a.xyz', fallback: { type: 'mark', props: {} } })
  assert.equal(custom.type, 'mark')
  // 每个收录的文件类型都必须真的内联到图标表里，缺一个就会落回回形针。
  const names = ['a.js', 'a.mjs', 'a.jsx', 'a.ts', 'a.tsx', 'a.json', 'a.md', 'a.css', 'a.scss', 'a.html',
    'a.vue', 'a.svelte', 'a.py', 'a.go', 'a.rs', 'a.java', 'a.kt', 'a.swift', 'a.c', 'a.h', 'a.cpp', 'a.cs',
    'a.rb', 'a.php', 'a.sh', 'a.bash', 'a.yml', 'a.yaml', 'a.toml', 'a.xml', 'a.sql', 'a.lock', 'a.png',
    'a.jpg', 'a.gif', 'a.webp', 'a.svg', 'a.pdf', 'a.zip', 'a.tar', 'a.gz', 'a.txt', 'a.log',
    'package.json', 'Dockerfile', '.gitignore', '.env', 'README.md', 'LICENSE']
  assert.deepEqual(names.filter(name => FileIcon({ name }).type !== 'img'), [],
    'every supported file format resolves to an inlined icon')
})

test('tool file extraction covers every engine argument shape and rejects non-file rows', async () => {
  const { toolFileChange } = await loadClient('tool-file.ts')
  // claude/qoder/zcode
  const read = toolFileChange('{"file_path":"/ws/src/a.ts"}', '/ws')
  assert.equal(read.path, '/ws/src/a.ts')
  assert.equal(read.display, 'src/a.ts')
  assert.equal(read.name, 'a.ts')
  assert.equal(read.directory, 'src/')
  assert.equal(read.counts, undefined)
  assert.equal(read.diffs.length, 0)
  const edit = toolFileChange('{"file_path":"x.ts","old_string":"old\\n","new_string":"new\\nline\\n"}', '/ws')
  assert.deepEqual(JSON.parse(JSON.stringify(edit.counts)), { added: 2, removed: 1 })
  assert.equal(edit.diffs[0].oldText, 'old\n')
  const write = toolFileChange({ file_path: 'n.md', content: 'hi\n' })
  assert.deepEqual(JSON.parse(JSON.stringify(write.counts)), { added: 1, removed: 0 })
  assert.equal(write.diffs[0].oldText, null)
  // pi
  assert.equal(toolFileChange({ path: 'x.ts', oldText: 'a\n', newText: 'b\n' }).diffs[0].oldText, 'a\n')
  const chained = toolFileChange({ path: 'x', edits: [{ oldText: 'a\n', newText: 'b\n' }, { oldText: 'b\n', newText: 'c\n' }] })
  assert.deepEqual(JSON.parse(JSON.stringify(chained.counts)), { added: 1, removed: 1 },
    'chained edits count the net change, matching summarizeChanges')
  assert.equal(chained.diffs.length, 2, 'hover still shows each intermediate edit')
  // codex: 对象与裸数组两种 changes 形态
  const patch = '@@ -1 +1 @@\n-old\n+new\n'
  const codex = toolFileChange({ changes: [{ path: 'a.ts', kind: 'modify', diff: patch }, { path: 'b.ts', kind: 'add', diff: patch }] }, '/ws')
  assert.deepEqual(JSON.parse(JSON.stringify(codex.counts)), { added: 2, removed: 2 }, 'counts sum every change patch')
  assert.equal(codex.diffs[1].patch, patch)
  assert.equal(toolFileChange([{ path: 'a.ts', diff: patch }]).diffs[0].patch, patch)
  // acp 系：rawInput 包裹
  const acp = toolFileChange({ rawInput: JSON.stringify({ file_path: 'x.ts', old_string: 'a\n', new_string: 'b\n' }) })
  assert.deepEqual(JSON.parse(JSON.stringify(acp.counts)), { added: 1, removed: 1 })
  assert.equal(toolFileChange({ rawInput: { path: 'x.ts' } }).name, 'x.ts')
  // 读取类工具把路径作为纯字符串传入
  assert.equal(toolFileChange('src/a.ts', '/ws').display, 'src/a.ts')
  // Windows 盘符路径按 \ 与 / 同样取末段
  const windows = toolFileChange('C:\\Users\\me\\a.ts', 'D:\\elsewhere')
  assert.equal(windows.name, 'a.ts')
  assert.equal(windows.directory, 'C:\\Users\\me\\')
  assert.equal(toolFileChange('src\\win.ts').name, 'win.ts')
  // 还原不出文件时保持原样
  assert.equal(toolFileChange('echo first'), null)
  assert.equal(toolFileChange('{"command":"ls -la"}'), null)
  assert.equal(toolFileChange(null), null)
  assert.equal(toolFileChange('{"pattern":"*.ts"}'), null)
  assert.equal(toolFileChange('folder/'), null)
  assert.equal(toolFileChange('folder\\'), null)
  // 被截断的 JSON 和 URL 不是路径
  assert.equal(toolFileChange('{"file_path":"/src/a.ts","old_string":"old'), null)
  assert.equal(toolFileChange('{"file_path":"partial'), null)
  assert.equal(toolFileChange('https://example.com/a.ts'), null)
})

test('resource references resolve file URIs and workspace paths and refuse everything else', async () => {
  const { referenceFile } = await loadClient('tool-file.ts', { globals: { URL } })
  // file: URI 还原为路径，cwd 内的绝对路径剥前缀
  const uri = referenceFile('file:///workspace/src/a.png', '/workspace')
  assert.equal(uri.path, '/workspace/src/a.png')
  assert.equal(uri.display, 'src/a.png')
  assert.equal(uri.name, 'a.png')
  assert.equal(uri.directory, 'src/')
  // 相对路径原样保留，交给 workspace-file 端点限定
  const relative = referenceFile('out/shot.png', '/ws')
  assert.equal(relative.path, 'out/shot.png')
  assert.equal(relative.display, 'out/shot.png')
  assert.equal(relative.name, 'shot.png')
  // cwd 内根目录文件与无 cwd 的相对路径
  assert.equal(referenceFile('file:///workspace/a.md', '/workspace').name, 'a.md')
  assert.equal(referenceFile('a.md').name, 'a.md')
  // cwd 外的绝对路径、远程地址、~、协议地址、空值与目录根都拒绝
  assert.equal(referenceFile('file:///tmp/outside.png', '/workspace'), null)
  assert.equal(referenceFile('/tmp/outside.png', '/workspace'), null)
  assert.equal(referenceFile('file:///tmp/x.png'), null)
  assert.equal(referenceFile('https://example.com/x.png'), null)
  assert.equal(referenceFile('ftp://example.com/x.png'), null)
  assert.equal(referenceFile('~/.codex/generated/x.png'), null)
  assert.equal(referenceFile('//host/share/x.png'), null)
  assert.equal(referenceFile(''), null)
  assert.equal(referenceFile(undefined), null)
  assert.equal(referenceFile('file:///'), null)
  assert.equal(referenceFile('file:///workspace'), null)
})

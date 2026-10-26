import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './helpers/client-module.js'

const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flatMap(nodes)]

test('file tree groups interleaved directories while preserving file identities, root files and input order', async () => {
  const { buildFileTree, FileTree } = await loadClient('file-tree.tsx')
  const files = [
    { path: '/ws/src/index.ts', relativePath: 'src/index.ts', additions: 3 },
    { path: '/ws/test/index.ts', relativePath: 'test/index.ts', deletions: 2 },
    { path: '/ws/src/lib/util.ts', relativePath: 'src/lib/util.ts' },
    { path: '/ws/src/helper.ts', relativePath: 'src/helper.ts' },
    { path: '/ws/README.md', relativePath: 'README.md' },
  ]
  const tree = buildFileTree(files)
  assert.deepEqual(Array.from(tree, node => [node.kind, node.name, node.depth]), [
    ['folder', 'src', 0], ['file', 'index.ts', 1], ['file', 'helper.ts', 1],
    ['folder', 'test', 0], ['file', 'index.ts', 1],
    ['folder', 'src/lib', 0], ['file', 'util.ts', 1], ['file', 'README.md', 0],
  ])
  const rendered = FileTree({ nodes: tree, renderFile: (node, content) => ({ type: 'file-action', props: { path: node.path }, children: [content] }) })
  assert.ok(nodes(rendered).some(node => node.children.includes(5)), 'folder headings do not inflate the file count')
  assert.deepEqual(nodes(rendered).filter(node => node.type === 'file-action').map(node => node.props.path),
    ['/ws/src/index.ts', '/ws/src/helper.ts', '/ws/test/index.ts', '/ws/src/lib/util.ts', '/ws/README.md'])
  assert.equal(nodes(rendered).filter(node => node.props.className === 'nodo-file-tree-added').length, 1)
  assert.equal(nodes(rendered).filter(node => node.props.className === 'nodo-file-tree-removed').length, 1)
  assert.equal(nodes(rendered).some(node => node.children.includes('+0') || node.children.includes('−0')), false, 'unknown totals are omitted')
})

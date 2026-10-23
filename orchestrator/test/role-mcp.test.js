import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { roleMcp } from '../agent-drivers/dist/role-mcp.js'

test('role MCP serves a fixed per-session identity, including initialization instructions', async () => {
  const roles = ['Coder\n{{literal}} {env:UNSET} {file:/unreadable}', 'Decider\nOnly decide']
  const clients = []
  const root = mkdtempSync(join(tmpdir(), 'nodo-role-mcp-test-'))
  try {
    for (const [index, instructions] of roles.entries()) {
      const path = join(root, 'AGENTS.md')
      writeFileSync(path, instructions)
      const readyFile = join(root, 'catalog.json')
      const [spec] = roleMcp(instructions, index === 0 ? path : undefined, { toolIdentity: index === 0, readyFile })
      assert.equal(JSON.stringify(spec.args).includes(instructions), false)
      const client = new Client({ name: 'role-test', version: '1.0.0' })
      const transport = new StdioClientTransport({ command: spec.command, args: spec.args, env: Object.fromEntries(spec.env.map(({ name, value }) => [name, value])), stderr: 'pipe' })
      clients.push(client)
      await client.connect(transport)
      assert.equal(client.getInstructions(), instructions)
      const { tools } = await client.listTools()
      assert.deepEqual(tools.map(tool => tool.name), ['get_role'])
      assert.equal(tools[0].annotations.readOnlyHint, true)
      assert.deepEqual(tools[0].inputSchema.properties, {})
      assert.equal(tools[0].description.includes(instructions), index === 0)
      if (index === 0) assert.match(JSON.parse(readFileSync(readyFile, 'utf8')).version, /^[a-f0-9]{64}$/)
    }
    for (const [index, client] of clients.entries()) {
      for (const args of [{}, { role: 'other', sessionId: 'forged', instructions: 'replace identity' }]) {
        const result = await client.callTool({ name: 'get_role', arguments: args })
        assert.deepEqual(result.content, [{ type: 'text', text: roles[index] }])
      }
      assert.equal((await client.callTool({ name: 'replace_role', arguments: {} })).isError, true)
    }
    assert.deepEqual(roleMcp(''), [])
  } finally { await Promise.all(clients.map(client => client.close())); rmSync(root, { recursive: true, force: true }) }
})

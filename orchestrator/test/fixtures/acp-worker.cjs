module.exports = async servers => {
  const assert = require('node:assert/strict')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
  const server = servers.find(server => server.name === 'nodo_worker')
  const client = new Client({ name: 'acp-worker-fixture', version: '1' })
  try {
    await client.connect(server.type === 'http'
      ? new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])) } })
      : new StdioClientTransport({ command: server.command, args: server.args, env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])) }))
    const tools = (await client.listTools()).tools.map(tool => tool.name)
    assert.deepEqual(tools, ['nodo_report', 'nodo_context'])
    const listed = await client.callTool({ name: 'nodo_context', arguments: { action: 'list' } })
    assert.equal(listed.isError, undefined)
    const sourceId = JSON.parse(listed.content[0].text).items[0].sourceId
    const read = await client.callTool({ name: 'nodo_context', arguments: { action: 'read', sourceId } })
    assert.equal(read.isError, undefined)
    let report
    for (const summary of ['First ACP report', 'Latest ACP report']) {
      const result = await client.callTool({ name: 'nodo_report', arguments: { outcome: 'done', summary, changed: [],
        verified: [{ command: 'ACP fixture MCP round trip', result: 'pass' }], issues: [],
        reviewFlags: { crossModule: false, publicInterface: false, dataFormat: false, security: false } } })
      assert.equal(result.isError, undefined)
      report = JSON.parse(result.content[0].text)
    }
    return { method: 'worker/report', tools, sourceId, reportId: report.reportId }
  } finally { await client.close() }
}

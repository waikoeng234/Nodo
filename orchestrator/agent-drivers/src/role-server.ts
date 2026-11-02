import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { readFileSync } from 'node:fs'
import { roleServer } from './role-mcp.js'

const instructions = process.env.NODO_ROLE_FILE ? readFileSync(process.env.NODO_ROLE_FILE, 'utf8') : process.env.NODO_ROLE_INSTRUCTIONS
const toolIdentity = process.env.NODO_ROLE_TOOL_IDENTITY === '1'
const readyFile = process.env.NODO_ROLE_READY_FILE
delete process.env.NODO_ROLE_INSTRUCTIONS
delete process.env.NODO_ROLE_FILE
delete process.env.NODO_ROLE_TOOL_IDENTITY
delete process.env.NODO_ROLE_READY_FILE
if (!instructions) process.exit(1)

await (await roleServer(instructions, { toolIdentity, readyFile })).connect(new StdioServerTransport())

#!/usr/bin/env node
// Opt-in real CLI check for the ZCode adapter.
//   node scripts/check-zcode.mjs [absolute-zcode-path]
// Read-only: it never creates a session, so the shared session store stays
// untouched. Whether a model can actually answer is only proven by a real
// conversation; this script verifies installation and protocol reachability.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkZcode } from '../agent-drivers/src/zcode/index.js'
import { findZcodeExecutable } from '../agent-drivers/src/zcode/index.js'

const requested = process.argv[2]
const executable = findZcodeExecutable(requested ?? 'zcode')
if (!executable) {
  console.error(`ZCode executable not found${requested ? ` (${requested})` : ' on PATH or in the ZCode app bundle'}.`)
  process.exit(1)
}
const workspace = mkdtempSync(join(tmpdir(), 'orch-zcode-check-'))
console.log(`Checking ZCode at ${executable} (read-only, no session is created)`)
try {
  const result = await checkZcode({ cwd: workspace, engineOptions: requested ? { bin: requested } : {} })
  for (const check of result.checks) console.log(`[${check.ok === null ? ' ~' : check.ok ? 'ok' : 'NO'}] ${check.label}: ${check.message}`)
  console.log(result.ok ? 'Environment is ready.' : 'Environment check failed.')
  process.exitCode = result.ok ? 0 : 1
} finally { rmSync(workspace, { recursive: true, force: true }) }

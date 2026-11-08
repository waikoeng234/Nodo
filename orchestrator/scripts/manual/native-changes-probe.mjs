import assert from 'node:assert/strict'
import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

export async function checkNativeChanges({ api, until, home, requests }) {
  const cwd = join(home, 'workspace')
  const workspace = await api('workspace-create', { name: 'Native file changes', cwd })
  const profile = await api('profile-create', { name: 'Native changes', engine: 'dsh', workspace: workspace.id, permission: 'full' })
  await api('send', { profile: profile.id, text: 'DSH_NATIVE_CHANGES: write only the supplied local files' })
  await until(async () => !(await api('state')).work[profile.id].active)
  const rows = await api('transcript', { profile: profile.id })
  const record = rows.find(row => row.kind === 'changes')?.presentation
  assert.ok(record, 'Loaded native workspaceChanges service must reach the driver summary')
  assert.equal(record.body.scope, 'workspace-snapshot')
  assert.equal(record.body.fileCount, 10)
  assert.equal(record.body.files.length, 3)
  const detail = await api('stream-detail', { profile: profile.id, ref: record.details.ref })
  assert.equal(detail.body.files.length, 10)
  assert.deepEqual(new Set(detail.body.files.map(file => file.path)), new Set(Array.from({ length: 10 }, (_, i) => join(realpathSync(cwd), `file-${i}.txt`))))
  for (const file of detail.body.files) {
    assert.equal(readFileSync(file.path, 'utf8'), 'native confirmed')
    assert.match(file.edits[0].diffText, /\+native confirmed/)
  }
  console.log(JSON.stringify({ result: 'passed', actualHost: 'DSH native', filesWritten: 10, reportedFiles: 10, source: detail.body.scope,
    previewFiles: 3, detailFiles: 10, publicSummaryAndDiff: true, localRequests: requests.length, remoteModelCalls: 0 }))
}

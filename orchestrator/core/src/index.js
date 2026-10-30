// Every module in src/ exports install(rt) and puts on `rt` the functions other
// modules call; modules never call each other during install, only at run time
// through `rt`. The MODULES order below is the registration order — diag first
// (it provides rt.warn), channel last (it wires the API surface over everything
// else); the caller's plugins install after the core modules.
import * as diag from './diag.js'
import * as store from './store.js'
import * as workspaces from './workspaces.js'
import * as worktrees from './worktrees.js'
import * as profiles from './profiles.js'
import * as sessions from './sessions.js'
import * as streamRecords from './stream-records.js'
import * as context from './context.js'
import * as sessionReferences from './session-references.js'
import * as secrets from './secrets.js'
import * as drivers from './drivers.js'
import * as engineSettings from './engine-settings.js'
import * as attachments from './attachments.js'
import * as stats from './stats.js'
import * as dispatch from './dispatch.js'
import * as approvals from './approvals.js'
import * as prompt from './prompt.js'
import * as taskTypes from './task-types.js'
import * as teams from './teams.js'
import * as lead from './lead.js'
import * as leadChannel from './lead-channel.js'
import * as channel from './channel.js'

const MODULES = [diag, store, workspaces, worktrees, profiles, sessions, streamRecords, context, sessionReferences, secrets, drivers, engineSettings, attachments, stats, dispatch, approvals, prompt, taskTypes, teams, lead, leadChannel, channel]

export async function createRuntime(host, config, plugins = []) {
  const rt = { ctx: host, config, home: config.home }
  for (const module of MODULES) module.install(rt)
  for (const plugin of plugins) plugin.install(rt)
  await rt.load()
  return rt
}

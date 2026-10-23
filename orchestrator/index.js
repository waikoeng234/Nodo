// Nodo: the user leads a set of coding agents 1:1. Workspaces (one
// directory each) come first; a profile = one role card bound to one engine (a
// coding CLI) configured under a workspace, and the profile's conversation is
// driven by that CLI through the agent-drivers package, not by dsh's own model.
// Transcripts, workspaces, profiles and workflows live in one JSON file under
// DSH_HOME so they survive restarts; one dsh host writes it at a time (store.js).
//
// Every module in src/host exports install(rt)
// and puts on `rt` the functions other modules call; modules never call each
// other during install, only at run time through `rt`. The MODULES order below is
// the registration order — diag first (it provides rt.warn), channel last (it
// wires the API surface over everything else).
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as diag from './src/host/diag.js'
import * as store from './src/host/store.js'
import * as workspaces from './src/host/workspaces.js'
import * as worktrees from './src/host/worktrees.js'
import * as profiles from './src/host/profiles.js'
import * as sessions from './src/host/sessions.js'
import * as streamRecords from './src/host/stream-records.js'
import * as context from './src/host/context.js'
import * as sessionReferences from './src/host/session-references.js'
import * as secrets from './src/host/secrets.js'
import * as drivers from './src/host/drivers.js'
import * as engineSettings from './src/host/engine-settings.js'
import * as adapter from './src/host/adapter/registry.js'
import * as adapterMap from './src/host/adapter/session-map.js'
import * as attachments from './src/host/attachments.js'
import * as stats from './src/host/stats.js'
import * as dispatch from './src/host/dispatch.js'
import * as nativeStatus from './src/host/native-status.js'
import * as approvals from './src/host/approvals.js'
import * as prompt from './src/host/prompt.js'
import * as runs from './src/host/runs.js'
import * as workflows from './src/host/workflows.js'
import * as channel from './src/host/channel.js'

export const name = 'nodo'
export const inject = ['connection', 'workspaceRegistry', 'sessionController', 'llm', 'tools', 'approval', 'agents', 'agentPresets', 'permissionPresets', 'userQuestions', 'systemPrompt', 'agentDefaultModel', 'attachments']

const MODULES = [diag, store, workspaces, worktrees, profiles, sessions, streamRecords, context, sessionReferences, secrets, drivers, engineSettings, adapterMap, adapter, attachments, stats, dispatch, nativeStatus, approvals, prompt, runs, workflows, channel]

export async function createRuntime(ctx, config = {}) {
  // The data directory keeps its old name so saved roles and sessions carry over.
  const rt = { ctx, config, home: config.home ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'orchestrator') }
  for (const module of MODULES) module.install(rt)
  await rt.initializeAdapters?.()
  await rt.recoverRuns()
  return rt
}

export async function apply(ctx, config = {}) {
  await createRuntime(ctx, config)
}

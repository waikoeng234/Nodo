// Nodo: the user leads a set of coding agents 1:1. Workspaces (one
// directory each) come first; a profile = one role card bound to one engine (a
// coding CLI) configured under a workspace, and the profile's conversation is
// driven by that CLI through the agent-drivers package, not by dsh's own model.
// Transcripts, workspaces, profiles and workflows live in one JSON file under
// DSH_HOME so they survive restarts; one dsh host writes it at a time (store.js).
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as core from './core/src/index.js'
import * as nativeStatus from './src/host/native-status.js'
import * as route from './src/host/route.js'

export const name = 'nodo'
export const inject = ['connection', 'workspaceRegistry', 'sessionController', 'llm', 'agents', 'agentPresets', 'permissionPresets', 'systemPrompt', 'agentDefaultModel', 'attachments']

export async function createRuntime(ctx, config = {}) {
  // The data directory keeps its old name so saved roles and sessions carry over.
  const home = config.home ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'orchestrator')
  return core.createRuntime(ctx, { ...config, home }, [nativeStatus, route])
}

export async function apply(ctx, config = {}) {
  await createRuntime(ctx, config)
}

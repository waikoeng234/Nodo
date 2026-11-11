// Fixture tasks are verbatim user messages, never leader-authored bodies.
export function userRoute(rt, owner, { task = 'Implement and verify', taskId, session, ...fields } = {}) {
  const id = typeof owner === 'string' ? owner : owner.id
  const line = rt.appendLine(id, { who: 'user', kind: 'text', text: rt.redactDeepSecrets(task) })
  const trigger = rt.setPendingTrigger(rt.triggerFromLine({ coordinatorSessionId: id, line }))
  if (session) fields.continues ??= Object.values(rt.state.executions).findLast(item => item.sessionId === session)?.taskId
  if (taskId) {
    const { type, hard, title, worktree, ...rest } = fields
    return { action: 'attach', taskId, scope: { quote: trigger.text }, ...rest,
      ...(worktree !== undefined ? { worktree } : {}) }
  }
  return { action: 'new', scope: { quote: trigger.text }, ...fields }
}

export const routeUserTask = (rt, owner, command) => rt.leadRoute(owner, userRoute(rt, owner, command))

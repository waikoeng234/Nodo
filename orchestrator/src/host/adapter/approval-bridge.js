// Approval seam for the adapter route: one engine ask becomes one native
// approval card (dsh-user-approval) and its outcome decides BOTH sides. The
// card is a real gate: every outcome except an explicit grant denies, so a
// headless or unavailable answerer fails closed.
export async function decideApproval(ctx, { agent, toolName, callId, reason, signal }) {
  const outcome = await ctx.approval.request({ agent, toolName, callId, reason, signal })
  return outcome === 'allowed-once' ? 'allow' : 'deny'
}

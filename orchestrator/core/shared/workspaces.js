export const projectAnchorOf = (workspaces, workspaceId) => {
  const found = workspaces.find(item => item.id === workspaceId)
  return found?.worktree?.project || workspaceId
}

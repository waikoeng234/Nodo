// Unsent drafts outlive the page: text goes to localStorage across reloads,
// pasted images (too large for storage) stay in memory across remounts.
export let heldImages = {}

export const setHeldImages = value => { heldImages = value }

export const readDrafts = () => {
  try { return JSON.parse(localStorage.getItem('nodo.drafts')) ?? {} } catch { return {} }
}

export const readScopes = () => {
  try { return JSON.parse(localStorage.getItem('nodo.taskScope')) ?? {} } catch { return {} }
}

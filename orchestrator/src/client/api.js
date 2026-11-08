export const ROUTE = '/api/nodo'

export const call = async (endpoint, payload) => {
  const response = await fetch(ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint, payload }),
  })
  const answer = await response.json()
  if (answer?.ok !== true) throw new Error(answer?.error?.message ?? 'request failed')
  return answer.value
}

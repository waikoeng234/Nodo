// The browser reaches these routes with its dsh session cookie; /api/orchestrator is the old name.
const ROUTE = '/api/nodo'

export function install(rt) {
  const { ctx } = rt
  for (const path of [ROUTE, '/api/orchestrator']) ctx.effect(() => ctx.connection.fetch.register({
    path,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const { endpoint, payload } = (await request.json().catch(() => null)) ?? {}
      return Response.json(await rt.handle(String(endpoint ?? ''), payload))
    },
  }), 'nodo: api route')
}

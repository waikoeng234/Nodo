const human = message => ['user', 'steering'].includes(message.source?.kind)
// An unconfirmed steer may already be in the engine's turn, so it is not sent again.
const taken = outcome => outcome === 'steered' || outcome === 'indeterminate'

export function installSteering(ctx, entryOf) {
  const deliveries = new WeakMap()
  const tails = new WeakMap()
  const records = agent => {
    if (!deliveries.has(agent)) deliveries.set(agent, new Map())
    return deliveries.get(agent)
  }
  const deliver = (agent, message) => {
    const entry = entryOf(agent.id)
    if (!entry?.pump.active || !human(message)) return null
    let delivery = records(agent).get(message.id)
    if (delivery) return delivery
    delivery = { queued: false, canceled: false }
    records(agent).set(message.id, delivery)
    delivery.done = (tails.get(entry) ?? Promise.resolve()).then(() => delivery.canceled ? 'refused' : entry.pump.steer(message)).catch(() => 'refused')
    tails.set(entry, delivery.done)
    return delivery
  }
  const queue = (agent, message, delivery) => {
    if (delivery.queued || delivery.canceled || agent.status !== 'running') return
    delivery.queued = true
    records(agent).delete(message.id)
    agent.inbox.remove(message.id)
    agent.followup(message)
  }
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (!agent.inbox.nextStep.some(item => item.id === message.id)) return
    const delivery = deliver(agent, message)
    if (delivery) void delivery.done.then(outcome => {
      if (!taken(outcome) && agent.inbox.nextStep.some(item => item.id === message.id)) queue(agent, message, delivery)
    })
  })
  ctx.on('agent/inbox/discarded', ({ agent, message }) => {
    const delivery = records(agent).get(message.id)
    if (delivery && !delivery.queued) delivery.canceled = true
  })
  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    const deferred = new Set()
    for (const message of messages) {
      const delivery = records(agent).get(message.id) ?? deliver(agent, message)
      if (!delivery) continue
      const outcome = await delivery.done
      signal.throwIfAborted()
      if (taken(outcome)) { records(agent).delete(message.id); continue }
      queue(agent, message, delivery)
      deferred.add(message.id)
    }
    return { ...decision, messages: decision.messages.filter(message => !deferred.has(message.id)) }
  }, { prepend: true })
  ctx.on('agent/disposed', ({ agent }) => deliveries.delete(agent))
}

const identity = text => text

export const shortTaskTitle = (text, redact = identity) => {
  const line = redact(String(text ?? '')).split(/\r?\n/)
    .map(line => line.trim().replace(/^(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, ''))
    .find(Boolean)
  return line === undefined ? '' : redact(line.replace(/\s+/g, ' ')).split(/[。！？]/)[0].slice(0, 40)
}

export const nodeTaskTitle = (node, redact = identity) => shortTaskTitle(node?.task ?? node?.question, redact)
  || shortTaskTitle([...(node?.files ?? []), ...(node?.images ?? [])].map(file => file.name).filter(Boolean).join('、'), redact)

export function workflowTitleSource(graph = {}) {
  const nodes = graph?.nodes ?? [], edges = graph?.edges ?? [], seen = new Set()
  const queue = nodes.filter(node => node.kind === 'start')
  let question
  while (queue.length) {
    const node = queue.shift()
    if (!node || seen.has(node.id)) continue
    seen.add(node.id)
    if (node.kind === 'agent') { question = node; break }
    if (node.kind === 'human' && !question && nodeTaskTitle(node)) question = node
    queue.push(...edges.filter(edge => edge.from === node.id && !edge.back).map(edge => nodes.find(item => item.id === edge.to)))
  }
  return question && { task: question.task, question: question.question,
    files: question.files?.map(({ name }) => ({ name })), images: question.images?.map(({ name }) => ({ name })) }
}

export const workflowTaskTitle = (graph, redact = identity) => nodeTaskTitle(workflowTitleSource(graph), redact) || '未命名任务'

export function runTaskTitle(title, source, redact = identity) {
  return title === undefined || title === (nodeTaskTitle(source) || '未命名任务')
    ? nodeTaskTitle(source, redact) || '未命名任务' : redact(title).slice(0, 80)
}

export function workflowSessionTitle(node, topic, redact = identity) {
  const title = nodeTaskTitle(node, redact)
  topic = redact(String(topic ?? ''))
  const relative = /上一步|上游|上一节点|前一步|上述|以上|上面|前面|之前|刚才|前文|前述|该报告|\b(?:previous step|upstream|above|earlier)\b/i.test(title)
    || /^(?:请)?(?:审查|检查|复核|测试|验证|修复|实现|同步文档|提交)(?:一下)?$|^(?:please\s+)?(?:review|check|test)(?:\s+(?:it|this))?$/i.test(title)
  return (title && (!relative || title === topic) ? title : [topic?.slice(0, 40), title].filter(Boolean).join(' · ')).slice(0, 80)
}

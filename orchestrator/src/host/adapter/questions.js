export async function answerQuestions(ctx, request, exec) {
  if (typeof ctx.userQuestions?.ask !== 'function') throw new Error('Native user questions are unavailable')
  const detail = request.detail ?? {}
  // Engines without a structured form still become one native card: the prompt
  // is the question, free-text choices ride as options.
  const questions = detail.questions ?? (detail.choices || detail.inputType
    ? [{ id: 'q0', question: request.reason ?? 'The engine asks for input',
      ...(Array.isArray(detail.choices) ? { options: detail.choices.map(choice => typeof choice === 'string' ? { label: choice } : choice) } : {}) }]
    : [])
  if (!questions.length) throw new Error('The engine supplied no questions')
  const answer = await ctx.userQuestions.ask({ agent: exec.agent, signal: exec.signal, questions })
  const byId = new Map(answer.answers.map(item => [item.id, item]))
  const values = Object.fromEntries(questions.map(({ id }) => {
    const { selected = [], custom } = byId.get(id) ?? {}
    const picked = [...selected, custom?.trim()].filter(Boolean)
    if (picked.length === 0) throw new Error('Answer every engine question')
    return [id, picked]
  }))
  return { value: questions.length === 1 ? values[questions[0].id].join('\n') : JSON.stringify(values) }
}

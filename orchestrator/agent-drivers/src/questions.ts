// The AskUserQuestion card the claude and qoder streams show, and the answer
// mapping they accept: one question answers as {question: text}, several as
// JSON keyed `q0..qn` or by question text, every question answered.
import type { DriverEvent } from './spi.js'

export type AskQuestion = { question: string; header: string; options?: unknown; multiSelect?: unknown }
export type AskInput = { questions?: AskQuestion[]; description?: string; command?: string }

export const askOpened = (prefix: string, sessionId: unknown, requestId: string, request: {
  tool_name?: string; input?: AskInput; description?: string; display_name?: string
}) => {
  const question = request.tool_name === 'AskUserQuestion'
  return {
    type: 'request/opened', id: `${prefix}:${sessionId}:${requestId}`, kind: question ? 'question' : 'permission',
    tool: request.tool_name,
    reason: question
      ? (request.input?.questions ?? []).map(item => item.question).join('\n')
      : request.description ?? request.input?.description ?? request.input?.command ?? `${request.display_name ?? request.tool_name} requests permission`,
    ...(question ? { detail: { questions: (request.input?.questions ?? []).map((item, index) => ({ id: `q${index}`, question: item.question, header: item.header,
      ...(item.options ? { options: item.options } : {}), ...(item.multiSelect === undefined ? {} : { multiSelect: item.multiSelect }) })) } }
      : { detail: { input: request.input } }),
  } as Extract<DriverEvent, { type: 'request/opened' }>
}

export function askAnswers(questions: AskQuestion[], value: unknown) {
  let answers: unknown
  if (questions.length === 1) answers = { [questions[0].question]: String(value ?? '').trim() }
  else {
    try { answers = JSON.parse(value as string) } catch { throw new Error('Answer each question using the form') }
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Error('Answer each question using the form')
  }
  const answerOf = (item: AskQuestion, index: number) => String((answers as Record<string, unknown>)?.[`q${index}`] ?? (answers as Record<string, unknown>)?.[item.question] ?? '').trim()
  if (questions.some((item, index) => answerOf(item, index) === '')) throw new Error('Answer every question first')
  return Object.fromEntries(questions.map((item, index) => [item.question, answerOf(item, index)]))
}

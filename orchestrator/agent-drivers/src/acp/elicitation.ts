export type ElicitationChoice = { const?: unknown; title?: unknown; description?: unknown }
export type ElicitationProperty = { title?: string; description?: string; type?: unknown; oneOf?: unknown; enum?: unknown; enumNames?: unknown[] }
export type ElicitationParams = { mode?: unknown; message?: string; requestedSchema?: { properties?: Record<string, ElicitationProperty>; required?: unknown } }
export type ElicitationQuestion = { id: string; question: string; options: { label: string; description?: unknown }[]; optional?: boolean }
export interface FormElicitation {
  card: { reason: string; detail: { questions: ElicitationQuestion[] } }
  answer(value?: string): { action: 'accept'; content: Record<string, unknown> }
}

// A plain `enum` (optionally titled by `enumNames`) offers the same choices as `oneOf`.
const choicesOf = (property?: ElicitationProperty): ElicitationChoice[] => Array.isArray(property?.oneOf) ? property.oneOf as ElicitationChoice[]
  : Array.isArray(property?.enum) ? (property.enum as unknown[]).map((value, index) => ({ const: value, title: property.enumNames?.[index] ?? value }))
    : []

export function formElicitation({ method, params }: { method: string; params: ElicitationParams }): FormElicitation | undefined {
  if (method !== 'elicitation/create' || (params.mode && params.mode !== 'form')) return
  const properties = params.requestedSchema?.properties ?? {}
  // Without a `required` list every question is treated as required.
  const required = Array.isArray(params.requestedSchema?.required) ? params.requestedSchema.required : undefined
  const questions = Object.entries(properties).filter(([key]) => !key.endsWith('_custom')).map(([key, property]) => ({
    id: key, question: property?.title ?? property?.description ?? key,
    options: choicesOf(property).map(option => ({ label: String(option.title ?? option.const), ...(option.description ? { description: option.description } : {}) })),
    ...(required && !required.includes(key) ? { optional: true } : {}),
  }))
  if (!questions.length) return
  return {
    card: { reason: params.message ?? questions.map(question => question.question).join('\n'), detail: { questions } },
    answer(value) {
      let values: Record<string, unknown>
      if (questions.length === 1) values = { [questions[0].id]: String(value ?? '').trim() }
      else {
        try { values = JSON.parse(value!) as Record<string, unknown> } catch { throw new Error('Answer each question using the form') }
        if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Answer each question using the form')
      }
      if (questions.some(question => !question.optional && !String(values?.[question.id] ?? '').trim())) throw new Error('Answer every question first')
      const content: Record<string, unknown> = {}
      for (const question of questions) {
        const answer = String(values[question.id] ?? '').trim()
        if (answer === '') continue
        const property = properties[question.id] ?? {}
        const choices = choicesOf(property)
        const choice = choices.find(option => String(option.const) === answer || option.title === answer)
        if (choice) content[question.id] = choice.const
        else if (properties[`${question.id}_custom`]) content[`${question.id}_custom`] = answer
        else if (choices.length) throw new Error(`Choose an option for "${question.question}"`)
        else if (property.type === 'number' || property.type === 'integer') {
          const parsed = Number(answer)
          if (property.type === 'integer' ? !Number.isInteger(parsed) : !Number.isFinite(parsed)) throw new Error(`Answer "${question.question}" with ${property.type === 'integer' ? 'a whole number' : 'a number'}`)
          content[question.id] = parsed
        } else if (property.type === 'boolean') {
          if (!/^(true|false)$/i.test(answer)) throw new Error(`Answer "${question.question}" with true or false`)
          content[question.id] = answer.toLowerCase() === 'true'
        } else content[question.id] = answer
      }
      return { action: 'accept', content }
    },
  }
}

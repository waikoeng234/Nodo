export function dshError(error: { method?: unknown; code?: unknown; data?: { details?: unknown }; message?: unknown }) {
  const prefix = `DSH ${error.method ?? 'connection'} failed${error.code ? ` (ACP ${error.code})` : ''}`
  const detail = typeof error.data?.details === 'string' ? error.data.details : ''
  const format = detail.match(/uses log format v(\d+), but this harness reads only v(\d+)/)
  if (format) return new Error(`${prefix}: saved session format v${format[1]} is newer than this CLI's v${format[2]}. Use a compatible DSH CLI to resume this session. New profiles use isolated agent storage; existing history is preserved.`)
  if (/already (owned|active)|write.*lock|owned by another/i.test(detail)) return new Error(`${prefix}: the saved session is in use by another DSH process. Close that session before resuming. Existing history is preserved.`)
  return new Error(`${prefix}: ${error.message}`)
}

// Real-CLI probes run on low-cost models. zcode's account (subscription)
// provider is fail-closed to externally spawned app-servers, so zcode uses the
// personal custom provider. Engines not listed keep their own default.
export const probeModels = {
  claude: { model: 'haiku', thinking: 'high' },
  codex: { model: 'gpt-6.1-terra', thinking: 'high' },
  zcode: { model: process.env.ZCODE_PROBE_MODEL ?? 'bigmodel-api$GLM-5.3-Flash', thinking: 'high' },
  opencode: { model: 'opencode-go/deepseek-v4.1-flash', thinking: 'high' },
  pi: { model: 'opencode-go/deepseek-v4.1-flash', thinking: 'high' },
}

// Limits and notes shared by the host modules.
// Per-profile transcript lines kept in state.json; older lines drop off the tail.
export const TRANSCRIPT_MAX = 800
export const TRANSCRIPT_TEXT_MAX = 16_000
export const NAME_MAX = 40
export const ROLE_MAX = 80
export const INSTRUCTIONS_MAX = 8000
export const TASK_TEXT_MAX = 32_000
export const HANDOFF_CONTEXT_MAX = 16_000
// The smallest per-image limit among the engines (Claude's API) bounds what is accepted.
export const IMAGE_BYTES_MAX = 5 * 1024 * 1024
export const IMAGES_MAX = 8
export const FILE_BYTES_MAX = 20 * 1024 * 1024
export const FILES_MAX = 8
export const ANSWER_TEXT_MAX = 8000
export const MAX_PROFILES = 24
// How long a driver spawn may take to say anything before a turn is failed.
export const TURN_IDLE_TIMEOUT_MS = 120_000
// Workflow run defaults, fixed into each run's snapshot when it starts.
export const RUN_LIMITS = { cancelConfirmMs: 15_000, backMax: 2, eventsMax: 1000 }
// The most times one back edge of a workflow may be declared to be taken.
export const RUN_BACK_MAX = 5
// Shown when the engine did not confirm a steered message in time.
export const UNCONFIRMED_STEER = '[Nodo] Agent 未在时限内确认插入的消息：它可能已并入本轮，也可能没有送达。若本轮回复没有涉及它，请重新发送。'

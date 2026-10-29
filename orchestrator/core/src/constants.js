// Limits and notes shared by the host modules.
// Per-profile transcript lines kept in state.json; older lines drop off the tail.
export const TRANSCRIPT_MAX = 800
export const TRANSCRIPT_TEXT_MAX = 16_000
export const NAME_MAX = 40
export const ROLE_MAX = 80
export const INSTRUCTIONS_MAX = 8000
export const TASK_TEXT_MAX = 32_000
// The smallest per-image limit among the engines (Claude's API) bounds what is accepted.
export const IMAGE_BYTES_MAX = 5 * 1024 * 1024
export const IMAGES_MAX = 8
export const FILE_BYTES_MAX = 20 * 1024 * 1024
export const FILES_MAX = 8
export const ANSWER_TEXT_MAX = 8000
export const MAX_PROFILES = 24
// Task-type catalog bounds for lead routing.
export const TASK_TYPES_MAX = 20
export const TASK_TYPE_NAME_MAX = 20
export const TASK_TYPE_WHEN_MAX = 200
// Silence limit before warning for a starting or active turn.
export const TURN_IDLE_TIMEOUT_MS = 120_000
// An engine-announced retry waits out its own backoff, so that stretch of
// silence gets a wider window before warning.
export const RETRY_IDLE_TIMEOUT_MS = 600_000
// An engine process with no work for this long is stopped; the next turn resumes its session.
export const DRIVER_IDLE_RELEASE_MS = 120_000
// Time allowed for an engine to confirm cancellation.
export const RUN_LIMITS = { cancelConfirmMs: 15_000 }
// Shown when the engine did not confirm a steered message in time.
export const UNCONFIRMED_STEER = '[Nodo] Agent 未在时限内确认插入的消息：它可能已并入本轮，也可能没有送达。若本轮回复没有涉及它，请重新发送。'

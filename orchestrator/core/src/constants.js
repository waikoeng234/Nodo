// Limits and notes shared by the host modules.
// Per-profile transcript lines kept in state.json; older lines drop off the tail.
export const TRANSCRIPT_MAX = 800
export const TRANSCRIPT_TEXT_MAX = 16_000
export const NAME_MAX = 40
export const ROLE_MAX = 80
export const INSTRUCTIONS_MAX = 8000
export const TASK_TEXT_MAX = 32_000
// Result sizes and context offsets count UTF-16 code units.
export const RESULT_PREVIEW_MAX = 200
export const RESULT_TEXT_MAX = 1_000_000
export const RESULTS_TEXT_MAX = 16_000_000
export const CONTEXT_PAGE_DEFAULT = 8_000
export const CONTEXT_PAGE_MAX = 16_000
export const CONTEXT_LIST_MAX = 50
// Delegation input budget counts UTF-16 code units of the composed dispatch body
// (running notes + task + required excerpts + background catalog), not tokens.
export const INPUT_CONTEXT_MAX = 96_000
// Lead-routed task flow bounds and the trigger-message storage quota.
export const FLOW_EXECUTIONS_MAX = 8
export const REWORK_MAX_DEFAULT = 2
export const SCOPE_NOTE_MAX = 100
export const HISTORY_USER_MAX = 6
export const HISTORY_REPLY_MAX = 6
export const HISTORY_TEXT_MAX = 20_000
export const TRIGGER_TEXT_TOTAL_MAX = 200_000
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
export const TEAMS_MAX = 12
export const TEAM_NAME_MAX = 20
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

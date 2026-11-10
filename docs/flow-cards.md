# Flow cards host API

M5b can use the existing `POST /api/nodo` envelope `{ endpoint, payload }`. Responses keep the existing `{ ok, value }` / `{ ok: false, error }` shape.

| Endpoint | Payload | Value |
| --- | --- | --- |
| `card-list` | `{ profile, session }` | All cards belonging to the selected coordinator session, including answered cards |
| `card-get` | `{ profile, session, cardId }` | One card, including its payload |
| `card-answer` | `{ profile, session, cardId, action, reason? }` | The answered card; when acceptance is blocked, query `card-list` for the replacement stall card |

`profile` and `session` resolve through the existing conversation API. Reads and answers validate coordinator ownership; answers additionally require a writable coordinator session. Answering a card never starts a coordinator turn or creates a decision.

```js
{
  id, coordinatorSessionId, taskId,
  kind: 'acceptance' | 'stall',
  status: 'open' | 'accepted' | 'rejected' | 'resolved',
  question: { id, question, whyUser, options, recommendation? },
  payload: {
    scope: { quote } | { note }, // Original task scope, unchanged.
    trigger: { id, summary }, // Up to 300 UTF-16 units of the original request.
    stages: [{ executionId, stage, status, summary, outcome, verdict?, structured,
      questions: [], supplementUnconfirmed }],
    evidence: [{ executionId, sourceId, evidence }],
    missedFlags: [], missedFlagsCount, recommendAccept,
    // Stall cards additionally provide:
    reason?, retryAction?, gaps?
  },
  createdAt, answeredAt?, answer?
}
```

Acceptance actions are `accept` and `return`; `return` requires a nonblank `reason`. Acceptance writes `task.acceptances[]` with `reason`, `basis`, `cardId`, `answer`, and `executionIds` through `completeTask`. A return rejects the card and starts rework using the user's exact reason as its trigger.

Stall actions are `retry`, `stop`, and `change-scope`. Count stalls (`rework-limit`, `hard-cap`, `stage-rounds`) omit `retry` and return `retryAction: null`. Retries preserve execution and rework counts. `change-scope` is reserved and returns `orch/not-supported` without changing the card or task, as decided for M5a.

`retryAction` is `restart-stage`, `rerun-review`, `check-review-type`, `redeliver-report`, or `check-acceptance`. `gaps` lists failed acceptance checks or dispatch errors. `missedFlagsCount` supports the label “漏报风险 N 项”. `structured: false` and `supplementUnconfirmed` support the existing report warning labels.

Each task has at most one open card. Different tasks can have open cards concurrently. Cards persist in `state.cards`; `recoverFlowCards()` recomputes open payloads after restart. `nodo_board table=cards` and `<nodo-status>` show open card summaries, while the host APIs provide full payloads.

Worker direct input supplements active tasks (`running`, `reviewing`, `accepting`). Stalled tasks require their card's retry action; accepted/stopped tasks and `reopenTask()` on flow tasks refuse new work with `orch/frozen`. Legacy task backend reopening remains unchanged.

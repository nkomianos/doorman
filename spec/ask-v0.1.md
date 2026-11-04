# The Ask format, `doorman.ask/0.1`

An **ask** is the one thing an agent sends when it needs a human. It is structured so that a router can decide *when* to interrupt, and so the same ask can be shown anywhere: a desktop toast, a phone notification with buttons, a watch, a voice prompt, a digest.

Status: draft. Breaking changes bump the version string.

## Design rules

1. **One question.** Answerable with one tap or one short phrase. Context goes in `detail`.
2. **Consequences up front.** Every option says what happens if you pick it.
3. **Say what silence means.** `deadline` + `default` tell the router it is safe to wait. An ask with a safe default rarely needs to interrupt anyone.
4. **Honest urgency.** Agents that cry wolf lose credibility, and the router lowers their urgency for them.
5. **Three zoom levels.** A line, a paragraph, the full context. Small screens show the first; the inbox shows all three.

## Fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `agent` | string or `{id, name, instance?}` | recommended | Who is asking. `id` is stable and keys the attention budget; `name` is what the human sees; `instance` identifies a session. |
| `kind` | `decision` \| `input` \| `inform` | inferred | `decision` = choose an option. `input` = free text or a small form. `inform` = FYI, no answer needed. Inferred from `options` / `input` when omitted. |
| `question` | string ≤ 300 | yes | The single question (or, for `inform`, the headline). Aim for ≤ 140. |
| `options` | array of string or `{id?, label, consequence?, style?}` | decision: ≥ 2 | Up to 8. `style` is `default`, `primary` or `danger`. `id` defaults to a slug of the label. |
| `input` | `{type: "text", placeholder?}` or `{schema}` | input | `schema` is a flat JSON Schema object (string, number, integer, boolean, enum properties), the same subset MCP elicitation uses. |
| `urgency` | `low` \| `normal` \| `high` \| `critical` | no (`normal`) | `critical` = harm or loss within minutes. |
| `deadline` | ISO time, epoch ms, or duration (`"15m"`) | no | When an answer stops being useful. |
| `default` | option id/label, or `{option, reason}` | no | Applied automatically at the deadline. Must be the safe choice. |
| `reversible` | boolean | no | Can the action be undone? Irreversible asks are never suggested for automation. |
| `delay_cost` | string | no | What waiting costs ("fare goes up €80 at 6pm"). |
| `detail` | string or `{line?, paragraph?, full?}` | no | Three zoom levels. A plain string is treated as `paragraph`. |
| `thread` | string | no | Groups related asks (a task, a ticket). |
| `collapse_key` | string | no | Like a mobile push collapse key: a new `inform` with the same key from the same agent replaces the unread older one. |
| `fingerprint` | string | no | Identifies "the same request" for rules and learning, e.g. `Bash:npm test`. Defaults to agent id + normalized question. |
| `tags` | string[] | no | Free-form labels; rules can match on them. |
| `metadata` | object | no | Opaque; stored and returned, never shown. |

### Example

```json
{
  "agent": { "id": "travel", "name": "Travel agent" },
  "question": "Lisbon flight dropped to €212 (was €298). Book it?",
  "options": [
    { "id": "book", "label": "Book", "style": "primary", "consequence": "Charges your saved card €212" },
    { "id": "skip", "label": "Skip", "consequence": "Keep watching the price" }
  ],
  "urgency": "high",
  "deadline": "20m",
  "default": "skip",
  "reversible": false,
  "delay_cost": "Fare usually rebounds within the hour",
  "detail": {
    "line": "TAP TP1351, Fri 14 Nov, 08:10 → 10:25",
    "paragraph": "Same itinerary you starred on Monday. 29% below the 30-day median."
  }
}
```

## Lifecycle

```
pending ──answer──▶ answered
   │  ├──rule────▶ auto        (one of your rules answered it)
   │  ├──dismiss─▶ dismissed   (default applied if there is one; agent budget shrinks)
   │  ├──deadline▶ defaulted   (default applied)  /  expired (no default)
   │  └──agent───▶ cancelled   (agent withdrew, e.g. answered in the terminal)
unread ──ack──▶ read            (inform)
```

The agent receives:

```json
{
  "id": "ask_…",
  "status": "answered",
  "final": true,
  "answer": { "option": "book", "label": "Book", "text": null, "values": null, "by": "human", "at": 1793766500000 },
  "delivery": { "mode": "interrupted", "reason": "high urgency while you're available" }
}
```

`answer.by` is `human`, `default`, or `rule:<id>`. Agents should treat `dismissed` without an option, and `expired`, as **no**.

## Delivery (what the router does)

Every ask is visible in the inbox immediately. The router only schedules the **interruption**:

| `delivery.mode` | Meaning |
|---|---|
| `queued` → `interrupted` | Pinged you. Asks that arrive within the bundle window (default 4s) share one notification. |
| `held` | Not worth interrupting now (you're focused, or the agent is over its budget). Re-evaluated continuously, and delivered at the next natural break. |
| `digest` | Low priority, or an FYI while you're busy. Delivered at digest times and when focus ends. |
| `snoozed` | You snoozed it. |
| `auto` / `muted` | Settled by your rules. |

The decision uses:

- **Your state** (`available` → normal+, `focus` → high+, `dnd` → critical only, `away` → high+ to phone only), from a manual override, your calendar, or quiet hours.
- **The agent's attention budget**: interruptions per hour, AIMD. +1 when you act on an interruption, ×0.5 when you dismiss one, ×0.75 when you ignore one until its deadline. `critical` bypasses the budget.
- **Credibility**: if you dismiss most of an agent's `high`/`critical` asks, its urgency is lowered one level.
- **Deadline pressure**: an ask with no safe default is escalated to `high` shortly before its deadline.

## HTTP binding

The reference daemon listens on `127.0.0.1:7777`. Every `/v1` route except `/v1/health` needs `Authorization: Bearer <token>`. The owner token is in `~/.doorman/token`.

Agents should use an **agent key** (`dk_…`, created in the inbox or with `POST /v1/keys`) instead. An agent key may only `POST /v1/asks`, read, wait for and `DELETE` its own asks, and `GET /v1/state`. Asks made with a key are always attributed to the key's agent id, whatever `agent` says, so one agent can't spend another's budget or trigger its rules.

| Method & path | |
|---|---|
| `POST /v1/asks[?wait=25s]` | Create an ask. Optional `wait` long-polls before returning. |
| `GET /v1/asks/:id/wait?timeout=25s` | Long-poll until final (max 60s per call; loop). |
| `GET /v1/asks/:id` | Current state. |
| `DELETE /v1/asks/:id` | Agent withdraws the ask. |
| `POST /v1/asks/:id/answer` | `{option}` or `{text}` or `{values}`; `always: true` makes a rule. |
| `POST /v1/asks/:id/dismiss` · `/ack` · `/snooze {for}` | Human responses. |
| `GET /v1/state` | Coarse human state for agents: `{mode, label, interruptible_for, until}`. |
| `GET /v1/events` | Server-sent events: `ask`, `update`, `state`, `interrupt`, `rules`, `agents`. |

Other routes (`/v1/agents`, `/v1/rules`, `/v1/ledger`, `/v1/config`, …) serve the inbox UI.

## MCP mapping

- `ask_human`, `notify_human`, `get_human_state`, `check_answer` tools (`doorman mcp`).
- MCP `elicitation/create` requests are converted to asks by `doorman proxy`: a single boolean or enum property becomes a `decision`, a single string becomes text `input`, anything else a form; `url` mode becomes Done/Decline. The answer maps back to `{action: accept|decline|cancel, content}`.

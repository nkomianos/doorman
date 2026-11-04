# doorman

**The attention layer for your AI agents.** One local router, owned by you, that decides when any of your agents gets to interrupt you.

```
 Claude Code ─┐                       ┌─▶ now, bundled into one ping
 Codex ───────┤                       ├─▶ held until your focus block ends
 MCP servers ─┼──▶  doorman router  ──┼─▶ saved for the 12:00 digest
 your scripts ┤   (budgets · state ·  ├─▶ answered by a rule you made
 any HTTP ────┘    rules · ledger)    └─▶ defaulted safely at the deadline
```

On mobile, notifications ended up being the real interface. Agents repeat that, more extremely: you'll run dozens of them, and every one invents its own chat window, approval prompt and way of pinging you. Each tool on the market sits on the **sender's** side, serving one developer's agent. Doorman sits on the **receiver's** side: yours, across all of them, the way your spam filter is yours and not the sender's.

In the demo below, three agents produce 12 asks in a few seconds. Without Doorman that's 12 interruptions. With Doorman it's **one**: the two urgent ones, bundled. Three are answered by a rule Doorman learned from you, one waits for your next break, and six go to the digest.

## Quick start

```bash
git clone https://github.com/nkomianos/doorman && cd doorman
npm install
node bin/doorman.js start          # inbox at http://127.0.0.1:7777
node bin/doorman.js demo           # in another terminal: three agents need you at once
```

Optionally `npm link` to get a global `doorman` command. Requires Node 20+. No database, no build step, no cloud account.

## How it decides

The router controls **interruptions, never visibility**. Every ask is in the inbox the moment it arrives; only the ping is scheduled. Every decision shows its reason ("Why: held, you're focused, waiting for a natural break").

| Mechanism | What it does |
|---|---|
| **Your state** | `available` lets normal+ through, `focus` high+, `dnd` only critical, `away` sends high+ to your phone. Set it from the inbox or CLI, or let your calendar (ICS) and quiet hours set it. Computed locally; agents only see the coarse mode, never your events. |
| **Bundling** | Asks arriving within a few seconds become one notification: "3 things need you (2 agents)". |
| **Natural breaks** | When focus ends, everything held arrives together with the digest, as one notification. |
| **Attention budgets** | Each agent may interrupt *n* times per hour. Acting on a ping grows its budget by 1; dismissing one halves it (AIMD, like TCP congestion control). Over budget, its asks wait. |
| **Credibility** | Dismiss most of an agent's "urgent" asks and its urgency is lowered for it. Crying wolf stops working. |
| **Deadlines & defaults** | An ask with a safe default can wait, and the default applies at the deadline. An ask with *no* safe default escalates shortly before its deadline. |
| **Rules & learning** | "Always allow `Bash:npm test` from this project." Answer the same way three times and Doorman suggests the rule. Irreversible actions are never suggested. |
| **Collapse keys** | A newer "build finished" replaces the unread older one, like mobile push collapse keys. |
| **Ledger** | Every ask, routing decision and answer, including what you were shown, goes into a hash-chained, append-only log (`doorman ledger verify`). That's the human-oversight record compliance teams will need. |

## Connect your agents

### Claude Code

```bash
doorman setup claude-code           # prints the hooks; add --write to merge into ~/.claude/settings.json
```

- **PermissionRequest** → Allow/Deny lands in your inbox (and phone). Your answer goes back to Claude Code. If nobody answers in time, Claude Code falls back to its normal prompt.
- **Stop** → "Finished in api: …" FYIs, one per session (collapsed).
- **Notification** → other "needs you" moments.
- Optionally `claude mcp add doorman -- node /path/to/bin/doorman.js mcp` gives Claude an `ask_human` tool for mid-task questions.

Each project gets its own budget and rules (`claude-code-<project>`).

### Any MCP client (Claude Code, Cursor, Codex, …)

`doorman mcp` is an MCP server with four tools:

| Tool | |
|---|---|
| `ask_human` | question, options with consequences, urgency, deadline, safe default, reversibility, delay cost, context. Waits up to `wait_seconds`, then returns a pending id. |
| `check_answer` | Pick up an answer later. |
| `notify_human` | FYI. Batched into digests unless urgent, so agents can use it freely. |
| `get_human_state` | `available` / `focus` / `dnd` / `away` plus the minimum urgency that may interrupt. |

### Wrap any MCP server: zero changes on either side

```bash
doorman proxy --name github --gate "create_*|delete_*|merge_*" -- npx -y @modelcontextprotocol/server-github
```

The proxy passes everything through, except that:
- tool calls matching `--gate` wait for your Allow/Deny (default: deny after 10 minutes);
- the server's **elicitation** requests (MCP's "ask the user") are routed to Doorman instead of the client's UI. Booleans and enums become one-tap decisions; other schemas become a form.

### Codex

```bash
doorman setup codex                 # notify = [...] for turn-complete FYIs, plus the MCP server
```

### Anything else: one HTTP call or one shell command

```bash
doorman ask "Backup is 3x larger than usual. Upload anyway?" -o Upload -o Skip --default Skip --deadline 30m
# prints "Upload" / "Skip"; exit 0 answered, 1 dismissed, 2 expired
```

```js
import { askHuman } from 'doorman-attention/client';
const r = await askHuman({ question: 'Pay the €1,240 invoice?', options: ['Pay now', 'Hold'], default: 'Hold', deadline: '2h', reversible: false });
```

See [`examples/`](examples) and the [Ask spec](spec/ask-v0.1.md).

## Your phone

Settings → Phone. Doorman pushes through [ntfy](https://ntfy.sh) (hosted or self-hosted) with one-tap answer buttons. Answers come back through a **reply topic** the daemon subscribes to, signed with HMAC, so it works from anywhere without exposing your machine to the internet. Turn on "Hide question text" if you don't want question content on a third-party server.

## The inbox

`http://127.0.0.1:7777`. A fresh install opens on a welcome screen with a **Run the demo** button.

- **Needs you**: decisions, split into "Pinged you" and "Didn't ping you", each with a deadline countdown and a plain-language line saying why it was or wasn't routed to you.
- **Answer, dismiss or mark read** and the card leaves at once, with **Undo** for 5 seconds before anything is sent to the agent.
- **Snooze** (5 min to tomorrow morning; times past the deadline are blocked) moves a request to **Snoozed**. When the snooze ends, it comes back and pings you, without using the agent's budget.
- **Status menu** (top right): Available, Focus, Do not disturb, Away or Automatic, each for 30 min to 4 hours or until you change it.
- **Updates**, **History** (filters and search), **Agents** (ping budget, credibility, mute), **Rules** (suggestions, plain-English rules, undo delete), **Activity log** (verify the chain), **Settings** (desktop and phone notifications with a test button and troubleshooting, schedule, delivery, copy-paste agent setup).

Keyboard: `j`/`k` move · `1`–`9` choose · `s` snooze · `d` dismiss · `e` more context · `a` always · `z` undo · `f` status · `g` then `i`/`u`/`s`/`h` to switch views · `?` all shortcuts.

On Windows, Doorman registers itself as a notification sender (per-user, no admin), so it shows up as **Doorman** under Settings → System → Notifications. If you don't see pop-ups, check that Windows' Do not disturb is off.

## The Ask format

The part meant to outlive this implementation. One question; options and their consequences; what happens if you don't answer, and by when; reversibility; what delay costs; detail at three zoom levels; who's asking. Structured, so one ask renders on a lock screen, a watch, in a voice prompt or a digest. [Read the spec →](spec/ask-v0.1.md)

## Security model

- Binds to `127.0.0.1` only, with a Host-header check against DNS rebinding.
- Every API call needs the bearer token in `~/.doorman/token` (created with mode 600).
- The human-state signal is computed on your machine. Agents get `{mode, label, interruptible_for, until}`, nothing else.
- Phone answers are HMAC-signed per ask and option; forged replies are ignored.
- The ledger is hash-chained; `doorman ledger verify` detects edits and deletions.
- The user is the customer: there is no way for an agent to buy priority.

## CLI

```
doorman start [--port 7777] [--detach]    doorman focus <available|focus|dnd|away|auto> [--for 90m]
doorman stop | status | open              doorman digest
doorman ask "…" -o A -o B [...]           doorman rules [list | add … | rm <id>]
doorman notify "…" [--urgency low]        doorman ledger [tail | verify | export]
doorman mcp                               doorman setup <claude-code|codex|cursor> [--write]
doorman proxy [--gate …] -- <cmd…>        doorman demo [--speed 2]
doorman hook <claude-code|codex>
```

State lives in `~/.doorman` (`DOORMAN_HOME` to change): `config.json`, `rules.json` (hand-editable), `state.json`, `ledger.jsonl`, `token`.

## Development

```bash
npm test      # unit tests for the router (fake clock), calendar, ledger and spec, plus end-to-end:
              # HTTP API, Claude Code hook, MCP server, MCP proxy, ntfy round-trip
```

Plain ESM JavaScript, two dependencies (`@modelcontextprotocol/sdk`, `zod`). `src/router.js` is the core; everything else is intake (hooks, MCP, proxy, HTTP) or surfaces (inbox, desktop, phone).

## Roadmap

- Watch and voice surfaces (the Ask format already carries a one-line form)
- Smarter natural-break detection: idle time, app focus, typing cadence (local only)
- Cross-agent merging of related asks (same trip, same PR) via `thread`
- Team mode: approval policies, escalation paths, audit export
- Native OS focus-mode integration (macOS Focus, Windows Focus assist)

## License

Apache-2.0

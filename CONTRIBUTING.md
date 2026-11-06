# Contributing

Thanks for helping make Switchboard better. Bug reports, new agent integrations and docs fixes are all welcome.

## Getting set up

```bash
git clone https://github.com/nkomianos/switchboard && cd switchboard
npm install
npm test
node bin/switchboard.js start      # in this terminal, with logs
```

Use a separate data folder so you don't touch your own inbox or agents while developing:

```bash
SWITCHBOARD_HOME=/tmp/sb SWITCHBOARD_AGENT_HOME=/tmp/agents node bin/switchboard.js start --port 7790
```

`SWITCHBOARD_AGENT_HOME` stands in for your home folder wherever Switchboard looks for agent configs and logs (`~/.claude`, `~/.codex`, …).

## How the code is laid out

- `src/router.js`: the core. Decides when each request interrupts you. Tested with a fake clock in `test/router.test.js`.
- `src/daemon.js`, `src/server.js`: the HTTP API, SSE and wiring.
- Intake: `src/hooks.js` (Claude Code, Codex), `src/mcp-server.js`, `src/proxy.js`, `src/client.js`.
- Surfaces: `ui/` (no build step), `src/notify.js` (desktop, ntfy), `src/telegram.js`.
- Setup: `src/integrations.js` (one-click connect), `src/system.js` (autostart, doctor).

## Adding an agent integration

Most agents speak MCP. Add an entry to `integrations()` in `src/integrations.js` (the `mcpJsonIntegration` helper covers JSON configs), then a test in `test/features.test.js` that connects and disconnects it inside a temporary home folder. Connecting must back up the file first and must only ever remove Switchboard's own entries.

## Pull requests

- Run `npm test`. CI runs it on Windows, macOS and Linux.
- Keep dependencies at two unless there's a very good reason.
- Write UI text and docs in plain, short sentences.
- Add a line to `CHANGELOG.md` under **Unreleased**.

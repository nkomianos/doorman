# Security

Switchboard sits between your AI agents and you, so it takes security seriously.

## Reporting a vulnerability

Please **don't open a public issue**. Use GitHub's private reporting instead:
[Report a vulnerability](https://github.com/nkomianos/switchboard/security/advisories/new).

Include what you found, how to reproduce it and what an attacker could do with it. You'll get a reply within a few days. Once a fix is out, you're credited in the changelog unless you'd rather not be.

## What Switchboard protects, and how

| Threat | Protection |
|---|---|
| A web page talking to the daemon | It listens on `127.0.0.1` only, checks the `Host` header (against DNS rebinding) and requires a bearer token for every API call. The inbox page never loads in a frame. |
| A local agent answering its own questions | Agents get **agent keys**, which can only send requests, wait for answers and read your coarse status. Only the owner token (in `~/.switchboard/token`, mode 600) can answer. |
| An agent pretending to be another | Requests made with an agent key are always attributed to that key's agent. |
| Forged one-tap answers (phone, desktop) | Every button carries an HMAC of the request and option; anything else is rejected. |
| Agents reading your files through Switchboard | Agent keys can't attach local file paths; only local hooks and the owner can. Attachments open in your editor or default app, never as programs. |
| Exposure to the internet | Off by default. With a tunnel, only `/mcp` and the agent routes answer from outside, and only with an agent key. The inbox, settings and owner token never answer remotely. |
| Tampering with history | Every request, decision and answer goes into a hash-chained log; `switchboard ledger verify` detects edits and deletions. |
| Your privacy | Agents only ever see Available, Focus, Do not disturb or Away. Calendar events, activity readings and other agents' requests stay on your computer. |

## Supported versions

Security fixes go into the latest release.

# Testing Switchboard on a Mac

About 15 minutes. You need Node 20+ (`node -v`; install from nodejs.org or `brew install node`).
Note anything that looks wrong, plus the output of `switchboard doctor`.

## 1. Install and first run

```bash
npm install -g github:nkomianos/switchboard
switchboard
```

- [ ] The browser opens `http://127.0.0.1:7777` with a "Welcome to Switchboard" checklist.
- [ ] `switchboard doctor` shows ✓ for Node, Install, Daemon and Desktop notifications.

## 2. Notifications

- [ ] Settings → **Send a test notification**: a macOS notification appears.
  If not, allow notifications for "Script Editor" (or your terminal app) in System Settings → Notifications, and check that Focus is off.
- [ ] Click **Run the demo** in the checklist: one notification arrives, not twelve.

## 3. Agents (whichever you have)

- [ ] The checklist says **Connect all N found** and lists your agents (Claude Code, Codex, Cursor, Claude Desktop…). Click it.
- [ ] Claude Code: start a **new** session, ask it to run a command that needs permission. Allow/Deny shows up in Switchboard; answering there continues Claude.
- [ ] When Claude or Codex finishes a turn, a "Finished in …" update appears under Updates.
- [ ] Codex: ask it to "use request_review on a short README you write". The review appears with a preview; **Request changes** with a comment, and Codex applies it.

## 4. Start at login and activity

- [ ] Settings → This computer → **Start with my computer** → Turn on. Check that `~/Library/LaunchAgents/co.switchboard.daemon.plist` exists.
- [ ] Log out and back in (or restart): `switchboard status` works without starting anything.
- [ ] Connect → turn on **Sense my activity**. The Now page shows the app in front within ~10 seconds. (macOS may ask for permission for System Events.)

## 5. Clean up

```bash
switchboard disconnect
switchboard autostart off
switchboard stop
npm uninstall -g @nkomianos/switchboard
```

- [ ] Your agents' configs are back to how they were (backups are next to each file as `.switchboard-bak`).

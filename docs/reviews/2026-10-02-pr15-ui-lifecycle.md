# PR #15 UI lifecycle evidence

This evidence covers only the Workspace App state change introduced by PR #15. It is not evidence that ChatGPT message delivery, continuation, browser connectivity, or long-turn lifecycle failures are fixed.

## Harness

The candidate `dist/ui/workspace-app.html` was loaded inside a local host page using the installed `@modelcontextprotocol/ext-apps` `AppBridge` and `PostMessageTransport`. The host completed the normal MCP Apps initialization handshake and sent tool input, then intentionally withheld the tool result for 35 seconds.

Observed sequence:

1. After initialization, the app rendered `Waiting for a tool result.`
2. At 30 seconds, the candidate rendered: `The host has not delivered this tool result to the card yet. Check the conversation status before retrying.`
3. At 35 seconds, the host sent a valid late `show_changes` result.
4. The warning cleared and the normal review card rendered (`Changed 1 file …`).

The recorded state transitions were independently confirmed from the browser accessibility tree while the evidence was captured.

## Assets

- `docs/assets/pr15-before-waiting.png` — in-flight state before the warning threshold.
- `docs/assets/pr15-after-warning.png` — bounded delivery warning after the threshold.
- `docs/assets/pr15-after-recovery.png` — normal review card after a late result.
- `docs/assets/pr15-timing.mov` — short timing capture spanning warning and late-result recovery.

## Scope limits

This is a local MCP Apps host simulation of the exact candidate UI bundle, not a production deployment and not a live ChatGPT acceptance run. Production was not restarted or modified to collect this evidence.

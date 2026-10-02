# PR #15 UI lifecycle evidence

This evidence covers only the Workspace App state change introduced by PR #15. It is not evidence that ChatGPT message delivery, continuation, browser connectivity, or long-turn lifecycle failures are fixed.

## Single-run static harness

The exact candidate `dist/ui/workspace-app.html` bundle was exercised in a local MCP Apps host using the installed `@modelcontextprotocol/ext-apps` `AppBridge` and `PostMessageTransport`.

The host itself was built once with `vite build` and then served as static files with `python -m http.server`. No Vite development server, HMR, live reload, or harness edit was active during the recorded run.

The host transport was connected before navigating the iframe, so the App's first `ui/initialize` could not race ahead of the bridge listener. The host rendered an explicit initialization counter and treated any value other than `1` as an error.

The visible run identifier is:

`RUN_ID=pr15-static-20261002-073933`

Across the full recorded sequence, the visible counter remained:

`init-count=1`

## One continuous recorded sequence

`docs/assets/pr15-timing.mov` is a single 45.061-second H.264 recording. All three PNGs below were extracted from this exact MOV by video frame PTS selection, not captured separately.

1. `docs/assets/pr15-before-waiting.png`
   - video PTS `>= 5s`;
   - visible `RUN_ID=pr15-static-20261002-073933`;
   - visible `init-count=1`;
   - app state: `Waiting for a tool result.`
2. `docs/assets/pr15-after-warning.png`
   - video PTS `>= 32s`;
   - same RUN_ID and `init-count=1`;
   - visible host clock approximately `t=30.9s`;
   - app state: `The host has not delivered this tool result to the card yet. Check the conversation status before retrying.`
3. `docs/assets/pr15-after-recovery.png`
   - video PTS `>= 38s`;
   - same RUN_ID and `init-count=1`;
   - visible host clock approximately `t=36.9s`;
   - host event: `late result delivered; review card recovered`;
   - app state: normal `Changed 1 file` review card with the sample diff rendered.

Equivalent extraction shape:

```sh
ffmpeg -i pr15-timing.mov -vf "select='gte(t,5)'"  -frames:v 1 pr15-before-waiting.png
ffmpeg -i pr15-timing.mov -vf "select='gte(t,32)'" -frames:v 1 pr15-after-warning.png
ffmpeg -i pr15-timing.mov -vf "select='gte(t,38)'" -frames:v 1 pr15-after-recovery.png
```

The initial waiting state and the final recovered state were also independently confirmed through the browser accessibility tree during this same run. The final accessibility state still reported `init-count=1` and the normal `Changed 1 file` review card.

## Why this replaces the earlier evidence

The earlier evidence set mixed independently captured screenshots with a development-server recording. Independent review correctly found that those files did not prove one continuous lifecycle, and the Vite development harness later exposed a second-initialization / asset-serving issue of its own.

This replacement deliberately removes that ambiguity:

- static production-built host;
- no dev server or HMR;
- explicit init counter;
- one continuous MOV;
- all three PNGs derived from that MOV;
- same RUN_ID visible in every state.

## Scope limits

This is a local MCP Apps host simulation of the exact candidate UI bundle, not a production deployment and not a live ChatGPT acceptance run. Production was not restarted or modified to collect this evidence.

It validates only the bounded UI lifecycle covered by PR #15:

`connected bridge + no tool result -> 30s warning -> late tool result -> normal review card`

It does not establish a root cause or fix for the separate ChatGPT message-delivery / continuation interruption seen in long conversations.

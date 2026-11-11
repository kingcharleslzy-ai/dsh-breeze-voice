# Host integration evidence

The installed DSH CLI is 0.2.1-rc.5. Read-only inspection found the native `conversation.input.right` list slot with session scope, `sessions.binding(sessionId).eventSource`, and `sessions.scope(sessionId).get('conversation')` exposing `send(text)` and `cancel()`.

Live assistant text is published as `assistant/live-chunk` with `data.chunk.type === 'text-delta'`. Settlement uses `assistant/message`, `surfaceOp: 'append'`, and `data.message.content`. This plugin waits for its new `turn/start`, ignores historical/other-turn entries, and fills only missing durable suffixes. `turn/end` flushes the sentence buffer. Reasoning deltas and tool call payloads are never sent to TTS.

REA static Evidence ID: `ev_74c098f36aa843cd7ef8b947be0a0e50399f8f1b31f4f76cb995321515857650`. Source package digest: `0d2b726bd1f04197ad97080907a4b08637ec08fa5264d573c2a1342187a8a922`. The complete local evidence is excluded from the npm package. Static inspection does not by itself establish microphone, desktop permissions or real audio quality.

Settings use the DSH configForms scope `breeze-voice`; fields are volatile. The package bundle id is `dsh-breeze-voice`. No patches to the host or the Qwen plugin are required.

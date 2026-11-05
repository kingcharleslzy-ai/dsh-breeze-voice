# Acceptance evidence — 2026-11-02 (Asia/Shanghai)

## Verified

- `npm run check`: TypeScript, 14 regression tests, and production host/browser bundle build passed.
- Actual installed DSH `0.2.1-rc.5` CLI installed the prebuilt package into an isolated `DSH_HOME`; host routes and native microphone slot loaded without plugin errors.
- Actual DSH plugin configuration panel rendered. Changing silence time to 900 ms persisted the native profile patch and immediately updated the running host configuration without restarting it.
- The floating call panel was visually checked in the actual DSH browser UI. A native stacking conflict was fixed with a viewport-clamped body portal.
- Synthetic browser audio traversed production capture, VAD, WAV encoding, multipart ASR, session submission, assistant event handling, PCM streaming and WebAudio playback. Three test utterances were sent. Speaking during a reply invoked one scoped cancellation and aborted one upstream PCM response; the subsequent utterance was submitted normally.
- Ending the synthetic call left the microphone track in `ended` state.
- Regression tests cover interrupted ASR, late microphone permission resolution, rejected permission, cold-service warmup, historical message/reasoning exclusion, durable/live deduplication, partial PCM frames, same-origin boundary, secret redaction and upstream abort propagation.

## Scope

The browser audio round trip uses a synthetic microphone, fake ASR text, deterministic PCM and a session fake matching observed native DSH contracts. The actual DSH host acceptance establishes installation, native slot registration, settings and errors. These checks do not establish real Mac microphone intelligibility, acoustic echo cancellation, subjective voice quality, or paid live LLM/tool behavior. Server GPU acceptance is recorded separately by the deployment workflow.

## Package installation cache

DSH/pnpm can reuse a local tarball when path and version remain unchanged even with `--force`. Install each revised build from an immutable hash-suffixed path, and compare installed files with archive members. Do not regard version equality as byte identity.

## v0.2.0 workbench and speech improvements

- Production client bundle rendered in an isolated real DSH web host: native sidebar `语音`, `main` panel, native configForms settings.
- Browser workbench flow verified: create a server reference voice, preview its `voiceId` before saving, save settings once through configForms, preserve existing connection values, apply persona/default prompt/idle interval/review/hotwords.
- Server synchronization failure after local save reports `本机已保存，服务器同步失败`; mobile 390px viewport has no horizontal page overflow.
- Actual shipped `SystemPrompt.assemble`/`renderPrompt` verified literal `{{...}}` remains literal, host prompt remains intact, only exact leased session gets voice/persona sections, and stop removes them. Unit tests additionally verify TTL expiry and live configuration changes.
- Actual shipped `SpeechToText` registry verified canonical WAV Buffer, explicit `sensevoice-local`, Chinese hint and provider removal. This test uses a registered test provider, so it verifies integration, not actual SenseVoice recognition quality or downloaded-model readiness.
- Actual native host origin loaded local ONNX Runtime script, WASM, ONNX and AudioWorklet assets. Recorded Chinese audio with a 600ms pause produced one utterance; a 200ms speech burst during playback caused zero interruptions. No live user microphone or paid LLM request was used.
- Editable recognition confirmation pauses admission until confirm/discard; tests verify no conversation send before confirmation, corrected text sent once, and session lease released on stop.
- Native ASR selection does not fall back or download when unprepared; when local ASR is ready and TTS is warm, it does not load the remote ASR model.

Real microphone intelligibility, different accents, acoustic echo, perceived stable-speaker similarity and real conversational timing still require user-device acceptance. Server synthesis and recognizer benchmarks are tracked separately by deployment evidence.

## v0.2.0 server qualification

- Full local checks: 46 TypeScript/browser unit tests and 37 Python gateway/ASR tests passed, plus production build.
- Real RTX 4090 D reference synthesis: three distinct sentences used the saved default reference; warm first PCM arrived in 0.179 / 0.187 seconds. First cold request took about 18 seconds. Reference cloning uses upstream `cfg_scale=1`; design uses `cfg_scale=4`.
- Real server voice creation saved a second named reference without replacing the default.
- Official Qwen3-ASR Chinese recording (4.204 seconds) transcribed exactly in about 0.216 seconds warm; hotwords and a -20 dB version also passed. Digital silence and seeded noise returned empty text after server-side Silero filtering. This is sample qualification, not a general accuracy benchmark or a comparison proving superiority to SenseVoice.
- Qwen ASR runs in an independent environment. Its isolated inference used about 4.9 GB additional GPU memory and returned to baseline after release. Combined TTS + ASR loaded used about 15.9 GB total, below available 4090 D memory.
- Actual cancellation followed immediately by a new speech request succeeded; gateway retries only upstream busy409 for at most3 seconds, before any audio is sent.
- Short-answer gate refined to192ms for listening while retaining480ms during playback; explicit submit retains128ms high-confidence candidates. All16 audio-focused tests passed after the refinement. Earlier real-browser fixtures establish model/worklet loading and audio flow, not a new live-microphone trial of these final thresholds.

# Private Windows CUDA deployment

Qualified runtime: Python 3.12.14, PyTorch 2.9.1+cu128, RTX 4090 D, Windows.
Use an independent venv and validate `import ctypes, torch` before deployment.
Do not change the environment of existing image/video services.

1. Create a private deployment directory with `venv`, `logs`, and `models` subdirectories. Copy the backend Python and PowerShell files into it.
2. Install `torch==2.9.1 torchaudio==2.9.1` from `https://download.pytorch.org/whl/cu128`, then install `requirements.txt` into that venv. Network/proxy configuration, if needed, is process-local.
3. Clone https://github.com/breezeblue-ai/breeze-tts into `upstream` and checkout `6eba901d1845353802652c708a4740fdfc5baa75`.
4. Run `python download_models.py`. Revisions are pinned. Read the model license before use: Breeze weights and self-hosted outputs carry research/noncommercial restrictions, independently of the code license.
5. Run `python configure_server.py --root <deployment>`. This refuses to replace an existing server config and generates a private random token. Restrict `token.txt` ACL to the service user and SYSTEM. Never ship it in the plugin package or publish it.
6. Run `register-service.ps1`. This registers a manual-start task under the current interactive Windows user, without login triggers. The Windows user must be logged in for an interactive task to start.
7. Set the plugin SSH host, task name, remote port 8870, local forwarded port, and API key using that deployment token. Only loopback addresses are listened on. Do not open a public firewall port.

`service-control.ps1 -Action status|start|stop|restart` operates only this deployment's exact gateway/worker process paths. Windows Task Scheduler stop alone can leave venv child interpreters alive; use this control script for maintenance.

`POST /v1/audio/warmup` loads both models when a voice call opens. `POST /v1/audio/speech` streams mono PCM16 LE at 24 kHz. `POST /v1/audio/transcriptions` accepts mono 16 kHz WAV. All routes require the bearer token. Cancelling the HTTP speech request closes upstream synthesis; the next request can proceed.

The idle reaper unloads both models after 600 seconds by default. TTS is a separate worker; its entire owned process tree is terminated on Windows. The gateway remains lightweight. Do not run GPU inference against other busy video tasks: the gateway refuses loading when free memory is insufficient, but an independently started video job can still compete after the voice model is loaded.

The Windows adapter in `tts_worker.py` captures upstream backbone/depth CUDA graphs without the optional Triton compilation step. Upstream source is unchanged. Eager inference was measured slower than playback on the qualification machine; do not silently substitute it and claim realtime behavior. Use the pinned source until a newer revision has passed real GPU regression tests.

The server never stores microphone recordings or transcript history. DSH's ordinary conversation history retains recognized user text and model replies. Test WAV outputs are separate explicitly created acceptance artifacts.

## v0.2 stable voices and optional Qwen3 ASR

Normal speech requires a saved reference voice (`voice` request field or persisted `default_voice_id`). Create one with `POST /v1/voices` using `{name,instruction}`, then select it through the DSH workbench or `POST /v1/voices/default` with `{voice_id}`. `GET /v1/voices` lists metadata. References live in `<deployment>/voices` unless `voices_dir` overrides it. Each sentence reuses the exact WAV and transcript, with upstream `ref_clone_tata` and `cfg_scale=1`; text descriptions alone do not lock speaker identity. `design:true` is reserved for description auditions. Never replace a reference file during a call.

`PATCH /v1/settings` persists `idle_seconds` (0 disables automatic unload; otherwise 60–7200). `POST /v1/models/unload` refuses active recognition/synthesis. `POST /v1/audio/warmup` accepts `{asr:false}` when DSH's local SenseVoice supplies recognition. The native recognizer's own lifecycle stays with DSH.

Qwen3-ASR is installed into a **separate** `asr-env` using `asr_requirements.txt`; keep the TTS environment unchanged. Pin `Qwen/Qwen3-ASR-1.7B` to revision `7278e1e70fe206f11671096ffdd38061171dd6e5`. Copy the package's `assets/vad/silero_vad_v5.onnx` into that model directory; the worker checks its SHA256 before loading. The worker uses local CPU ONNX VAD to reject silence/noise before ASR and never downloads while serving.

Add these fields to the existing private `server.json`, preserving credentials and other values:

```json
{
  "asr_engine": "qwen3-asr",
  "asr_python": "C:\\VoiceServer\\asr-env\\Scripts\\python.exe",
  "asr_model": "C:\\VoiceServer\\models\\qwen3-asr-1.7b",
  "asr_worker_port": 8874,
  "asr_min_free_mb": 6000
}
```

Omitting `asr_engine` retains the earlier faster-whisper implementation and requires its original model path. Qwen's worker is loopback-only, started on demand by the gateway and stopped as an owned process tree on idle release. `hotwords` is an optional multipart transcription field (at most 2000 characters). No automatic fallback sends recordings to another provider.

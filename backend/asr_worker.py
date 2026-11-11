"""Private, disposable Qwen3-ASR worker; gateway owns its process lifetime.

Run in the independent asr-env, never the Breeze TTS environment. Model files
are downloaded separately at a pinned revision; runtime is strictly offline.
Only loopback is exposed. Authentication and idle unloading belong to gateway.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import io
import logging
import os
import re
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Callable

import numpy as np
import soundfile as sf
from fastapi import FastAPI, File, Form, HTTPException, UploadFile

ENGINE = "qwen3-asr-1.7b"
SOURCE_REVISION = "7c6daf77a2421100f5fb066495372c00129d39ff"
MODEL_REVISION = "7278e1e70fe206f11671096ffdd38061171dd6e5"
MAX_BYTES = 4 * 1024 * 1024
MAX_SECONDS = 90
MAX_HOTWORDS = 2000
VAD_SHA256 = "2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f"


class SpeechPresence:
    """CPU Silero v5 presence gate; keep the entire waveform when speech exists.

    Uses the official 512-sample/64-sample-context recurrent ONNX protocol.
    Two 32 ms frames above .35 suffice, avoiding a long-duration gate that
    rejects short replies. This is a no-speech guard, not utterance trimming.
    Model provenance/license: assets/vad/PROVENANCE.json and silero-LICENSE.txt.
    """
    def __init__(self, model_path: str):
        import onnxruntime as ort
        path = Path(model_path) / "silero_vad_v5.onnx"
        with path.open("rb") as model:
            if hashlib.file_digest(model, "sha256").hexdigest() != VAD_SHA256:
                raise RuntimeError("Silero VAD model does not match the pinned asset")
        options = ort.SessionOptions()
        options.inter_op_num_threads = 1
        options.intra_op_num_threads = 1
        self.session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"], sess_options=options)

    def __call__(self, samples: np.ndarray) -> bool:
        state = np.zeros((2, 1, 128), dtype=np.float32)
        context = np.zeros(64, dtype=np.float32)
        consecutive = 0
        for offset in range(0, len(samples), 512):
            frame = samples[offset:offset+512]
            if len(frame) < 512:
                frame = np.pad(frame, (0, 512-len(frame)))
            audio = np.concatenate((context, frame)).reshape(1, 576)
            probability, state = self.session.run(["output", "stateN"],
                {"input": audio, "state": state, "sr": np.array(16000, dtype=np.int64)})
            context = frame[-64:]
            score = float(probability.reshape(-1)[0])
            consecutive = consecutive + 1 if score >= .35 else 0
            if consecutive >= 2 or score >= .8:
                return True
        return False


def vocabulary_context(hotwords: str) -> str:
    """Pass vocabulary as upstream ASR context, never substitute decoded text."""
    words = re.sub(r"[\x00-\x1f\x7f]+", " ", hotwords).strip()
    return f"以下是可能出现的词语：{words}" if words else ""


def decode_wav(raw: bytes) -> np.ndarray:
    if not raw or len(raw) > MAX_BYTES:
        raise HTTPException(413, "WAV upload must be between 1 byte and 4 MiB")
    try:
        with sf.SoundFile(io.BytesIO(raw)) as audio:
            if audio.format != "WAV" or audio.samplerate != 16000 or audio.channels != 1:
                raise HTTPException(422, "Expected 16 kHz mono WAV")
            if not 0 < audio.frames <= MAX_SECONDS * 16000:
                raise HTTPException(422, "Audio must be nonempty and at most 90 seconds")
            samples = audio.read(dtype="float32")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(422, "Invalid WAV audio") from exc
    if not np.isfinite(samples).all():
        raise HTTPException(422, "Audio contains non-finite samples")
    return samples


def load_model(model_path: str):
    # No cloud calls or automatic model downloads during live conversations.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    import torch
    from qwen_asr import Qwen3ASRModel

    torch.set_num_threads(6)
    if not torch.cuda.is_available():
        raise RuntimeError("Qwen3-ASR requires the configured CUDA device")
    model = Qwen3ASRModel.from_pretrained(
        str(Path(model_path).resolve()), dtype=torch.bfloat16,
        device_map="cuda:0", attn_implementation="sdpa",
        local_files_only=True, max_inference_batch_size=1, max_new_tokens=1024,
    )
    model.model.generation_config.do_sample = False
    model.model.generation_config.num_beams = 1
    model.model.eval()
    return model


def create_app(model_path: str, loader: Callable = load_model, gate_loader: Callable | None = None) -> FastAPI:
    lock = threading.Lock()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.speech_gate = await asyncio.to_thread(gate_loader or SpeechPresence, model_path)
        app.state.model = await asyncio.to_thread(loader, model_path)
        yield
        app.state.model = None

    app = FastAPI(lifespan=lifespan)
    app.state.model = None

    @app.get("/health")
    def health():
        return {"ready": app.state.model is not None, "engine": ENGINE,
                "source_revision": SOURCE_REVISION, "model_revision": MODEL_REVISION,
                "instance_id": os.environ.get("BREEZE_ASR_INSTANCE_ID", ""),
                "busy": lock.locked()}

    def infer(samples: np.ndarray, hotwords: str):
        if app.state.model is None:
            raise HTTPException(503, "ASR model is not ready")
        if not lock.acquire(blocking=False):
            raise HTTPException(429, "ASR worker is busy")
        try:
            duration = len(samples) / 16000
            # Suppress exact/near-digital silence without suppressing soft speech.
            if np.max(np.abs(samples)) < 0.0001 or not app.state.speech_gate(samples):
                return {"text": "", "language": "", "duration": duration, "engine": ENGINE}
            result = app.state.model.transcribe(
                audio=(samples, 16000), context=vocabulary_context(hotwords), language="Chinese",
            )[0]
            return {"text": result.text.strip(), "language": result.language,
                    "duration": duration, "engine": ENGINE}
        except HTTPException:
            raise
        except Exception as exc:
            logging.exception("Qwen ASR inference failed")
            raise HTTPException(500, "ASR inference failed; see worker log") from exc
        finally:
            lock.release()

    @app.post("/transcribe")
    async def transcribe(file: UploadFile = File(...), hotwords: str = Form("")):
        if len(hotwords) > MAX_HOTWORDS:
            raise HTTPException(422, "Hotwords must be at most 2000 characters")
        raw = await file.read(MAX_BYTES + 1)
        samples = decode_wav(raw)
        return await asyncio.to_thread(infer, samples, hotwords)

    return app


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--port", type=int, default=8874)
    args = parser.parse_args()
    import uvicorn
    uvicorn.run(create_app(args.model), host="127.0.0.1", port=args.port, access_log=False)

"""Synchronous on-demand Qwen ASR subprocess bridge, owned by gateway Runtime.

The caller serializes transcribe/stop using its ASR lock. This module never
imports torch or qwen_asr into the TTS environment and never downloads models.
"""
from __future__ import annotations

import io
import os
from pathlib import Path
import subprocess
import time
import uuid
from typing import Callable

import httpx
import numpy as np
import soundfile as sf
from fastapi import HTTPException

WINDOWS = os.name == "nt"

def gpu_free_mb() -> int:
    return int(subprocess.check_output(
        ["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits", "--id=0"],
        timeout=8, text=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    ).strip().splitlines()[0])


class QwenASRBridge:
    def __init__(self, config: dict, memory_probe: Callable[[], int] = gpu_free_mb):
        self.config = config
        self.memory_probe = memory_probe
        self.worker = None
        self.worker_log = None
        self.http = None
        self._ready = False
        self.instance_id = ""
        self.url = f"http://127.0.0.1:{int(config.get('asr_worker_port', 8874))}"

    @property
    def ready(self) -> bool:
        return self._ready and self.worker is not None and self.worker.poll() is None

    def _healthy(self) -> bool:
        try:
            response = self.http.get(self.url + "/health", timeout=2)
            if response.status_code != 200:
                return False
            state = response.json()
            return (state.get("ready") is True and state.get("engine") == "qwen3-asr-1.7b"
                    and state.get("instance_id") == self.instance_id)
        except (httpx.HTTPError, ValueError):
            return False

    def _ensure(self):
        if self.ready and self._healthy():
            return
        self.stop()
        python = Path(self.config["asr_python"])
        model = Path(self.config["asr_model"])
        if not python.is_file() or not (model / "config.json").is_file():
            raise HTTPException(503, "Qwen ASR 独立环境或模型文件尚未安装。")
        free = self.memory_probe()
        if free < self.config.get("asr_min_free_mb", 4500):
            raise HTTPException(503, f"ASR 空闲显存不足（{free} MB），请等待其他 GPU 任务结束。")
        log_dir = Path(self.config["log_dir"])
        log_dir.mkdir(parents=True, exist_ok=True)
        env = os.environ.copy()
        self.instance_id = uuid.uuid4().hex
        env.update(PYTHONUTF8="1", HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1",
                   BREEZE_ASR_INSTANCE_ID=self.instance_id)
        argv = [str(python), str(Path(__file__).with_name("asr_worker.py")),
                "--model", str(model), "--port", str(self.config.get("asr_worker_port", 8874))]
        try:
            self.worker_log = (log_dir / "asr-worker.log").open("ab", buffering=0)
            self.http = httpx.Client(timeout=httpx.Timeout(120, connect=5), trust_env=False)
            self.worker = subprocess.Popen(
                argv, stdout=self.worker_log, stderr=subprocess.STDOUT, env=env,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            deadline = time.monotonic() + self.config.get("asr_load_timeout_seconds", 180)
            while time.monotonic() < deadline:
                if self.worker.poll() is not None:
                    raise HTTPException(503, "Qwen ASR 启动失败，请查看服务器 asr-worker.log。")
                if self._healthy():
                    self._ready = True
                    return
                time.sleep(.25)
            raise HTTPException(503, "Qwen ASR 模型加载超时。")
        except BaseException:
            self.stop()
            raise

    def transcribe(self, samples: np.ndarray, hotwords: str = "") -> dict:
        samples = np.asarray(samples, dtype=np.float32)
        if samples.ndim != 1 or not 0 < samples.size <= 90 * 16000 or not np.isfinite(samples).all():
            raise HTTPException(422, "ASR 需要有效的 16 kHz 单声道录音，最长 90 秒。")
        if not isinstance(hotwords, str) or len(hotwords) > 2000:
            raise HTTPException(422, "ASR 热词最多 2000 个字符。")
        self._ensure()
        audio = io.BytesIO()
        sf.write(audio, samples, 16000, format="WAV", subtype="PCM_16")
        try:
            response = self.http.post(self.url + "/transcribe",
                files={"file": ("microphone.wav", audio.getvalue(), "audio/wav")},
                data={"hotwords": hotwords})
            if response.status_code in (413, 422, 429):
                raise HTTPException(response.status_code, "ASR 录音无效或识别器忙，请稍后重试。")
            response.raise_for_status()
            result = response.json()
            if not isinstance(result.get("text"), str) or result.get("engine") != "qwen3-asr-1.7b":
                raise ValueError("Unexpected ASR response")
            return result
        except HTTPException:
            raise
        except (httpx.HTTPError, ValueError, AttributeError) as exc:
            self.stop()
            raise HTTPException(502, "Qwen ASR 服务识别失败，请重试并检查 asr-worker.log。") from exc

    def stop(self):
        """Stop only this instance's owned process tree and close its handles."""
        self._ready = False
        try:
            worker = self.worker
            if worker is not None:
                if worker.poll() is None:
                    if WINDOWS:
                        subprocess.run(["taskkill", "/PID", str(worker.pid), "/T", "/F"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20,
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                    else:
                        worker.terminate()
                try:
                    worker.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    worker.kill()
                    worker.wait(timeout=10)
                self.worker = None
        finally:
            if self.http is not None:
                self.http.close()
                self.http = None
            if self.worker_log is not None:
                self.worker_log.close()
                self.worker_log = None


# Short alias for gateway callers.
ASRBridge = QwenASRBridge

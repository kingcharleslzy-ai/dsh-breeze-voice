import sys
from pathlib import Path

import httpx
import numpy as np
import pytest
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).parent))
import asr_bridge


class Process:
    pid = 7341

    def __init__(self):
        self.exit_code = None
        self.terminated = False

    def poll(self):
        return self.exit_code

    def terminate(self):
        self.terminated = True
        self.exit_code = 0

    def wait(self, timeout):
        self.exit_code = 0
        return 0


@pytest.fixture
def rig(tmp_path, monkeypatch):
    python = tmp_path / "python.exe"
    python.touch()
    model = tmp_path / "model"
    model.mkdir()
    (model / "config.json").write_text("{}")
    config = {"asr_python": str(python), "asr_model": str(model),
              "log_dir": str(tmp_path / "logs"), "asr_load_timeout_seconds": 1}
    bridge = asr_bridge.QwenASRBridge(config, memory_probe=lambda: 12000)
    state = {"spawned": [], "requests": [], "health_foreign": False, "response_status": 200}
    process = Process()

    def spawn(argv, **kwargs):
        state["spawned"].append((argv, kwargs))
        return process

    def handler(request):
        state["requests"].append(request)
        if request.url.path == "/health":
            return httpx.Response(200, json={"ready": True, "engine": "qwen3-asr-1.7b",
                "instance_id": "foreign" if state["health_foreign"] else bridge.instance_id})
        return httpx.Response(state["response_status"], json={"text": "测试", "language": "Chinese",
            "duration": 1, "engine": "qwen3-asr-1.7b"})

    real_client = httpx.Client
    monkeypatch.setattr(asr_bridge.subprocess, "Popen", spawn)
    monkeypatch.setattr(asr_bridge.httpx, "Client",
                        lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw))
    monkeypatch.setattr(asr_bridge, "WINDOWS", False)
    yield bridge, state, process
    bridge.stop()


def test_lazily_starts_isolated_offline_worker_and_reuses_it(rig):
    bridge, state, process = rig
    assert not state["spawned"] and not bridge.ready
    assert bridge.transcribe(np.ones(16000), "星河语音")["text"] == "测试"
    assert bridge.ready
    argv, kwargs = state["spawned"][0]
    assert argv[0] == bridge.config["asr_python"]
    assert argv[-2:] == ["--port", "8874"]
    assert kwargs["env"]["HF_HUB_OFFLINE"] == "1"
    assert kwargs["env"]["TRANSFORMERS_OFFLINE"] == "1"
    assert kwargs["env"]["BREEZE_ASR_INSTANCE_ID"] == bridge.instance_id
    request = state["requests"][-1]
    assert "星河语音".encode() in request.content and b"RIFF" in request.content
    bridge.transcribe(np.ones(16000))
    assert len(state["spawned"]) == 1
    log, client = bridge.worker_log, bridge.http
    bridge.stop()
    assert process.terminated and log.closed and client.is_closed
    assert not bridge.ready


def test_insufficient_vram_and_invalid_audio_never_start_worker(rig):
    bridge, state, _ = rig
    bridge.memory_probe = lambda: 4499
    with pytest.raises(HTTPException) as err:
        bridge.transcribe(np.ones(16000))
    assert err.value.status_code == 503
    with pytest.raises(HTTPException) as err:
        bridge.transcribe(np.array([np.nan]))
    assert err.value.status_code == 422
    assert not state["spawned"]


def test_startup_timeout_closes_handles_and_stops_owned_process(rig):
    bridge, state, process = rig
    bridge.config["asr_load_timeout_seconds"] = 0
    with pytest.raises(HTTPException) as err:
        bridge.transcribe(np.ones(16000))
    assert err.value.status_code == 503
    assert process.terminated
    assert bridge.http is None and bridge.worker_log is None


def test_process_creation_failure_closes_log_and_client(rig, monkeypatch):
    bridge, _, _ = rig

    def failed_spawn(*args, **kwargs):
        raise OSError("Cannot execute worker")

    monkeypatch.setattr(asr_bridge.subprocess, "Popen", failed_spawn)
    with pytest.raises(OSError):
        bridge.transcribe(np.ones(16000))
    assert bridge.http is None and bridge.worker_log is None and bridge.worker is None


def test_does_not_adopt_foreign_worker_on_same_port(rig):
    bridge, state, process = rig
    state["health_foreign"] = True
    bridge.config["asr_load_timeout_seconds"] = .01
    with pytest.raises(HTTPException):
        bridge.transcribe(np.ones(16000))
    assert not bridge.ready and process.terminated


def test_windows_stop_targets_only_owned_process_tree(rig, monkeypatch):
    bridge, _, process = rig
    bridge.transcribe(np.ones(16000))
    monkeypatch.setattr(asr_bridge, "WINDOWS", True)
    commands = []
    monkeypatch.setattr(asr_bridge.subprocess, "run", lambda argv, **kw: commands.append(argv))
    bridge.stop()
    assert commands == [["taskkill", "/PID", "7341", "/T", "/F"]]


@pytest.mark.parametrize("status,stopped", [(500, True), (429, False), (422, False)])
def test_inference_failure_cleanup_vs_input_or_busy_error(rig, status, stopped):
    bridge, state, process = rig
    state["response_status"] = status
    with pytest.raises(HTTPException):
        bridge.transcribe(np.ones(16000))
    assert process.terminated == stopped
    assert bridge.ready != stopped

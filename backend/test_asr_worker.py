import io
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).parent))
from asr_worker import create_app
import asr_worker


@pytest.fixture(autouse=True)
def fake_speech_presence(monkeypatch):
    monkeypatch.setattr(asr_worker, "SpeechPresence", lambda _: lambda samples: True)


def wav(samples=None, rate=16000, channels=1):
    data = np.full((16000, channels), .03) if samples is None else samples
    stream = io.BytesIO()
    sf.write(stream, data, rate, format="WAV", subtype="FLOAT")
    return stream.getvalue()


class Model:
    def __init__(self):
        self.calls = []

    def transcribe(self, **kwargs):
        self.calls.append(kwargs)
        return [SimpleNamespace(text=" 星河语音 DSH。 ", language="Chinese")]


def test_hotwords_reach_model_without_text_replacement():
    model = Model()
    with TestClient(create_app("unused", lambda _: model)) as client:
        assert client.get("/health").json()["ready"]
        response = client.post("/transcribe", files={"file": ("mic.wav", wav())},
                               data={"hotwords": "星河语音\nDSH"})
        assert response.status_code == 200
        assert response.json() == {"text": "星河语音 DSH。", "language": "Chinese",
                                   "duration": 1.0, "engine": "qwen3-asr-1.7b"}
        assert model.calls[0]["context"] == "以下是可能出现的词语：星河语音 DSH"
        assert model.calls[0]["language"] == "Chinese"
        assert model.calls[0]["audio"][1] == 16000


@pytest.mark.parametrize("audio", [b"not audio", wav(rate=8000), wav(channels=2),
                                    wav(np.zeros(0)), wav(np.full(16000, np.nan)),
                                    wav(np.zeros(16000 * 91))])
def test_invalid_audio_never_reaches_model(audio):
    model = Model()
    with TestClient(create_app("unused", lambda _: model)) as client:
        assert client.post("/transcribe", files={"file": ("mic.wav", audio)}).status_code in (413, 422)
        assert not model.calls


def test_silence_is_empty_and_hotwords_are_bounded():
    model = Model()
    with TestClient(create_app("unused", lambda _: model)) as client:
        response = client.post("/transcribe", files={"file": ("mic.wav", wav(np.zeros(16000)))})
        assert response.json()["text"] == ""
        assert not model.calls
        assert client.post("/transcribe", files={"file": ("mic.wav", wav())},
                           data={"hotwords": "词" * 2001}).status_code == 422


def test_neural_no_speech_result_skips_asr_but_keeps_short_speech():
    model = Model()
    for has_speech in (False, True):
        with TestClient(create_app("unused", lambda _: model,
                                   gate_loader=lambda _: lambda samples: has_speech)) as client:
            response = client.post("/transcribe", files={"file": ("mic.wav", wav(np.ones(1600)*.002))})
            assert response.status_code == 200
            assert bool(response.json()["text"]) == has_speech
    assert len(model.calls) == 1
    assert len(model.calls[0]["audio"][0]) == 1600


def test_concurrent_inference_rejected_and_health_stays_responsive():
    entered, release = threading.Event(), threading.Event()

    class SlowModel(Model):
        def transcribe(self, **kwargs):
            entered.set()
            assert release.wait(5)
            return super().transcribe(**kwargs)

    with TestClient(create_app("unused", lambda _: SlowModel())) as client:
        with ThreadPoolExecutor() as pool:
            future = pool.submit(client.post, "/transcribe", files={"file": ("mic.wav", wav())})
            try:
                assert entered.wait(5)
                assert client.get("/health").json()["busy"]
                assert client.post("/transcribe", files={"file": ("mic.wav", wav())}).status_code == 429
            finally:
                release.set()
            assert future.result().status_code == 200


def test_inference_error_releases_lock():
    class FailedModel:
        def transcribe(self, **kwargs):
            raise RuntimeError("broken")

    with TestClient(create_app("unused", lambda _: FailedModel())) as client:
        for _ in range(2):
            assert client.post("/transcribe", files={"file": ("mic.wav", wav())}).status_code == 500
            assert not client.get("/health").json()["busy"]

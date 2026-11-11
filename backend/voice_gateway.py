"""Private, on-demand Breeze TTS + faster-whisper gateway.

Run: python voice_gateway.py --config path/to/server.json
Only the gateway persists while idle; the GPU worker and ASR model unload.
"""
from __future__ import annotations
import argparse
import asyncio
import contextlib
import gc
import io
import json
import logging
import os
from pathlib import Path
import secrets
import subprocess
import sys
import threading
import time
from contextlib import asynccontextmanager

import anyio
import httpx
import numpy as np
import soundfile as sf
from fastapi import FastAPI, File, HTTPException, Request, UploadFile, Form
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field, ConfigDict, StrictInt

from voice_library import VoiceLibrary, REFERENCE_TEXT, atomic_json
from asr_bridge import QwenASRBridge

log = logging.getLogger('breeze-voice')
MAX_AUDIO_BYTES = 8 * 1024 * 1024


class OwnedPCMResponse(StreamingResponse):
    """Release upstream resources even if disconnect precedes body iteration."""
    def __init__(self, content, cleanup, **kwargs):
        super().__init__(content, **kwargs)
        self.cleanup = cleanup

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            with anyio.CancelScope(shield=True):
                await self.cleanup()


class ServiceSettings(BaseModel):
    model_config = ConfigDict(extra='forbid')
    idle_seconds: StrictInt = Field(ge=0, le=7200)


class SpeechRequest(BaseModel):
    input: str = Field(min_length=1, max_length=2000)
    instructions: str = Field(default='一位自然亲切的年轻女性，普通话清晰，语速适中，像面对面聊天一样。', max_length=1000)
    voice: str | None = None
    response_format: str = 'pcm'
    design: bool = False


class WarmupRequest(BaseModel):
    asr: bool = True


class VoiceDesign(BaseModel):
    model_config = ConfigDict(extra='forbid')
    name: str = Field(min_length=1, max_length=80)
    instruction: str = Field(min_length=1, max_length=1000)


class DefaultVoice(BaseModel):
    model_config = ConfigDict(extra='forbid')
    voice_id: str = Field(min_length=32, max_length=32)


def decode_wav(data: bytes) -> np.ndarray:
    if len(data) > MAX_AUDIO_BYTES or not data.startswith(b'RIFF') or data[8:12] != b'WAVE':
        raise ValueError('需要 WAV 录音，文件最大 8 MB。')
    with sf.SoundFile(io.BytesIO(data)) as wav:
        if wav.samplerate != 16000 or wav.channels != 1:
            raise ValueError('录音须为 16 kHz 单声道 WAV。')
        if wav.frames > 16000 * 90:
            raise ValueError('单次录音不能超过 90 秒。')
        samples = wav.read(dtype='float32')
    if samples.size < 1600:
        raise ValueError('录音过短，请再说一次。')
    if not np.isfinite(samples).all():
        raise ValueError('录音包含无效采样。')
    return samples


def gpu_free_mb() -> int:
    value = subprocess.check_output(
        ['nvidia-smi', '--query-gpu=memory.free', '--format=csv,noheader,nounits', '--id=0'],
        timeout=8, text=True,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
    ).strip().splitlines()[0]
    return int(value)


class Runtime:
    def __init__(self, config: dict):
        self.config = config
        self.token = Path(config['token_file']).read_text().strip()
        if len(self.token) < 32:
            raise ValueError('A private bearer token of at least 32 characters is required')
        self.worker: subprocess.Popen | None = None
        self.worker_log = None
        self.start_lock = asyncio.Lock()
        self.speech_lock = asyncio.Lock()
        self.asr_lock = threading.Lock()
        self.asr = None
        self.asr_bridge = QwenASRBridge(config, memory_probe=gpu_free_mb) if config.get('asr_engine')=='qwen3-asr' else None
        self.asr_busy = False
        self.last_activity = time.monotonic()
        self.worker_state = 'unloaded'
        self.worker_url = f"http://127.0.0.1:{config.get('worker_port',8871)}"
        self.http = httpx.AsyncClient(timeout=httpx.Timeout(180, connect=5), trust_env=False)
        self.started = time.time()
        self.settings_lock = asyncio.Lock()
        self.voices = VoiceLibrary(config.get('voices_dir', str(Path(config['token_file']).parent / 'voices')))

    def touch(self):
        self.last_activity = time.monotonic()

    async def ensure_worker(self):
        async with self.start_lock:
            if self.worker is not None and self.worker.poll() is None:
                try:
                    response = await self.http.get(self.worker_url+'/health', timeout=2)
                    if response.status_code == 200:
                        return
                except httpx.HTTPError:
                    pass
            if self.worker is not None:
                await self.stop_worker()
            free = await asyncio.to_thread(gpu_free_mb)
            if free < self.config.get('tts_min_free_mb', 11000):
                raise HTTPException(503, f'GPU 空闲显存不足（{free} MB），请等待其他 GPU 任务结束。')
            self.worker_state = 'loading'
            log_dir = Path(self.config['log_dir'])
            log_dir.mkdir(parents=True, exist_ok=True)
            self.worker_log = (log_dir/'tts-worker.log').open('ab', buffering=0)
            env = os.environ.copy()
            env['PYTHONUTF8'] = '1'
            env['HF_HUB_OFFLINE'] = '1'
            env['TRANSFORMERS_OFFLINE'] = '1'
            argv = [sys.executable, str(Path(__file__).with_name('tts_worker.py')),
                    '--source', self.config['breeze_source'], '--model', self.config['tts_model'],
                    '--port', str(self.config.get('worker_port',8871))]
            self.worker = subprocess.Popen(argv, stdout=self.worker_log, stderr=subprocess.STDOUT,
                env=env, creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            try:
                deadline = time.monotonic() + self.config.get('load_timeout_seconds',180)
                while time.monotonic() < deadline:
                    if self.worker.poll() is not None:
                        raise RuntimeError('Breeze 进程启动失败，请查看服务器 tts-worker.log。')
                    try:
                        response = await self.http.get(self.worker_url+'/health', timeout=2)
                        if response.status_code == 200:
                            self.worker_state='ready'
                            return
                    except httpx.HTTPError:
                        pass
                    await asyncio.sleep(.35)
                raise RuntimeError('Breeze 模型加载超时。')
            except BaseException:
                await self.stop_worker()
                raise

    async def stop_worker(self):
        worker, self.worker = self.worker, None
        if worker is not None and worker.poll() is None:
            if os.name == 'nt':
                # Windows venv python is a launcher with a child interpreter.
                # Terminate only this owned process tree, including GPU child.
                await asyncio.to_thread(subprocess.run,
                    ['taskkill','/PID',str(worker.pid),'/T','/F'],
                    stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                    creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0),timeout=20)
            else:
                worker.terminate()
            try:
                await asyncio.to_thread(worker.wait, 15)
            except subprocess.TimeoutExpired:
                worker.kill()
                await asyncio.to_thread(worker.wait)
        if self.worker_log:
            self.worker_log.close()
            self.worker_log = None
        self.worker_state='unloaded'

    def transcribe(self, samples, hotwords=""):
        if not self.asr_lock.acquire(blocking=False):
            raise HTTPException(429, '已有语音正在识别，请稍候。')
        self.asr_busy = True
        self.touch()
        try:
            if self.asr_bridge is not None:
                result = self.asr_bridge.transcribe(samples,hotwords)
                self.asr = {'engine':'qwen3-asr'}
                return result
            if self.asr is None:
                device = self.config.get('asr_device','cuda')
                if device == 'cuda' and gpu_free_mb() < 2200:
                    raise HTTPException(503, 'GPU 空闲显存不足，暂时无法加载语音识别。')
                # CTranslate2 uses CUDA DLLs shipped in the private PyTorch environment.
                if os.name == 'nt':
                    import importlib.util
                    torch_spec = importlib.util.find_spec('torch')
                    dll_dir = str(Path(torch_spec.origin).parent/'lib')
                    os.environ['PATH'] = dll_dir + os.pathsep + os.environ.get('PATH','')
                    self._dll_handle = os.add_dll_directory(dll_dir)
                from faster_whisper import WhisperModel
                self.asr = WhisperModel(self.config['asr_model'], device=device,
                    compute_type='int8_float16' if device=='cuda' else 'int8', cpu_threads=6,
                    num_workers=1, local_files_only=True)
            segments, info = self.asr.transcribe(samples, language=self.config.get('language','zh'),
                beam_size=5, vad_filter=True, condition_on_previous_text=False, initial_prompt=hotwords or None,
                vad_parameters={'min_silence_duration_ms':450}, no_speech_threshold=.6)
            text = ''.join(segment.text for segment in segments).strip()
            return {'text':text,'language':info.language,'duration':len(samples)/16000}
        finally:
            self.asr_busy=False
            self.touch()
            self.asr_lock.release()

    def settings(self):
        return {'idle_seconds': self.config.get('idle_seconds',600)}

    async def save_settings(self, idle_seconds: int):
        if idle_seconds != 0 and idle_seconds < 60:
            raise HTTPException(400,'闲置释放时间至少 1 分钟，或设为 0 保持加载。')
        async with self.settings_lock:
            updated={k:v for k,v in self.config.items() if not k.startswith('_')}
            updated['idle_seconds']=idle_seconds
            self.persist(updated)
            self.config['idle_seconds']=idle_seconds
            self.touch()
        return self.settings()

    def persist(self, updated):
        location = self.config.get('_config_path')
        if not location:
            raise HTTPException(503, '此网关未配置持久设置路径，无法保存。')
        atomic_json(Path(location), updated)

    async def set_default_voice(self, voice_id):
        try:
            self.voices.get(voice_id)
        except (ValueError, OSError) as exc:
            raise HTTPException(400, str(exc)) from exc
        async with self.settings_lock:
            updated = {k:v for k,v in self.config.items() if not k.startswith('_')}
            updated['default_voice_id'] = voice_id
            self.persist(updated)
            self.config['default_voice_id'] = voice_id
        return {'default_voice_id': voice_id}

    def speech_request(self, body):
        data = {'text':body.input, 'cfg_scale':'4', 'seed':'42'}
        if body.design:
            if not body.instructions.strip():
                raise HTTPException(400, '设计音色需要音色描述')
            data['instruction'] = body.instructions
            return self.http.build_request('POST', self.worker_url+'/v1/audio/speech', data=data)
        voice_id = body.voice or self.config.get('default_voice_id')
        if not voice_id:
            raise HTTPException(409, '请先在语音设置中生成并保存音色，再开始对话。')
        try:
            entry, audio = self.voices.get(voice_id)
        except (ValueError, OSError) as exc:
            raise HTTPException(400, str(exc)) from exc
        # Reuse the exact same waveform and transcript on every turn. Do not
        # mix voice-design instructions into the reference-cloning template.
        data['cfg_scale'] = '1'  # ref_clone_tata has no negative prompt
        data['ref_text'] = entry['reference_text']
        return self.http.build_request('POST', self.worker_url+'/v1/audio/speech', data=data,
            files={'ref_audio': ('reference.wav', audio, 'audio/wav')})

    async def open_speech(self, body, request):
        # A disconnected prior stream may still be finishing one CUDA chunk.
        # Retry only an explicit busy rejection, never a partially sent stream.
        deadline = time.monotonic() + 3
        while True:
            if await request.is_disconnected():
                raise HTTPException(499, 'Client disconnected')
            response = await self.http.send(self.speech_request(body), stream=True)
            if response.status_code != 409 or time.monotonic() >= deadline:
                return response
            await response.aclose()
            await asyncio.sleep(.1)

    async def unload(self):
        # Acquire the ASR lock before awaiting worker shutdown; an ASR request
        # cannot start midway through release. Never interrupt an active request.
        if self.speech_lock.locked() or self.start_lock.locked() or not self.asr_lock.acquire(blocking=False):
            raise HTTPException(409,'语音服务正在处理请求，结束后才能释放模型。')
        try:
            async with self.speech_lock:
                async with self.start_lock:
                    await self.stop_worker()
                if self.asr_bridge is not None:
                    await asyncio.to_thread(self.asr_bridge.stop)
                self.asr=None
                gc.collect()
        finally:
            self.asr_lock.release()

    async def reap(self):
        while True:
            await asyncio.sleep(15)
            idle=self.config.get('idle_seconds',600)
            if idle == 0 or time.monotonic()-self.last_activity < idle:
                continue
            if self.worker is None and self.asr is None:
                continue
            try:
                await self.unload()
            except HTTPException as exc:
                if exc.status_code != 409:
                    raise


def create_app(config: dict) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app):
        rt=Runtime(config)
        app.state.runtime=rt
        reaper=asyncio.create_task(rt.reap())
        try:
            yield
        finally:
            reaper.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await reaper
            await rt.stop_worker()
            if rt.asr_bridge is not None:
                await asyncio.to_thread(rt.asr_bridge.stop)
            await rt.http.aclose()

    app=FastAPI(title='DSH Breeze Voice',lifespan=lifespan,docs_url=None,redoc_url=None)

    @app.middleware('http')
    async def authenticate(request:Request,call_next):
        expected='Bearer '+app.state.runtime.token
        if not secrets.compare_digest(request.headers.get('authorization',''),expected):
            return JSONResponse({'detail':'Unauthorized'},status_code=401)
        length=request.headers.get('content-length')
        if length:
            try:
                if int(length)>MAX_AUDIO_BYTES+65536:
                    return JSONResponse({'detail':'Request too large'},status_code=413)
            except ValueError:
                return JSONResponse({'detail':'Invalid Content-Length'},status_code=400)
        return await call_next(request)

    @app.get('/health')
    async def health():
        rt=app.state.runtime
        if rt.worker is not None and rt.worker.poll() is not None:
            rt.worker_state = 'failed'
        if rt.asr_bridge is not None and not rt.asr_bridge.ready:
            rt.asr = None
        idle=config.get('idle_seconds',600)
        loaded=rt.worker_state=='ready' or rt.asr is not None
        return {'status':'ok','ready':rt.worker_state=='ready' and rt.asr is not None,
            'tts':rt.worker_state,'asr':'ready' if rt.asr is not None else 'unloaded',
            'sample_rate':24000,'idle_seconds':idle,'asr_engine':config.get('asr_engine','whisper'),
            'idle_remaining_seconds':max(0,round(idle-(time.monotonic()-rt.last_activity))) if idle and loaded else None,
            'busy':rt.speech_lock.locked() or rt.asr_busy,'version':'0.2.0',
            'capabilities':{'persistent_settings':True,'manual_release':True,'voice_design':True,'reference_voices':True}}

    @app.get('/v1/settings')
    async def settings():
        return app.state.runtime.settings()

    @app.patch('/v1/settings')
    async def save_settings(body:ServiceSettings):
        return await app.state.runtime.save_settings(body.idle_seconds)

    @app.post('/v1/models/unload')
    async def release():
        await app.state.runtime.unload()
        return {'status':'ok','tts':'unloaded','asr':'unloaded'}

    @app.post('/v1/audio/warmup')
    async def warmup(body:WarmupRequest=WarmupRequest()):
        rt=app.state.runtime
        rt.touch()
        try:
            async with rt.speech_lock:
                await rt.ensure_worker()
            if body.asr and rt.asr is None:
                await asyncio.to_thread(rt.transcribe, np.zeros(16000, dtype='float32'))
        except (RuntimeError,OSError,httpx.HTTPError) as exc:
            raise HTTPException(503,str(exc)) from exc
        finally:
            rt.touch()
        return {'status':'ok','ready':True,'sample_rate':24000}

    @app.get('/v1/voices')
    async def voices():
        rt = app.state.runtime
        return {'voices':rt.voices.list(), 'default_voice_id':config.get('default_voice_id', '')}

    @app.post('/v1/voices/default')
    async def voice_default(body:DefaultVoice):
        return await app.state.runtime.set_default_voice(body.voice_id)

    @app.post('/v1/voices')
    async def design_voice(body:VoiceDesign, request:Request):
        rt = app.state.runtime
        if not body.name.strip() or not body.instruction.strip():
            raise HTTPException(400, '音色名称和描述不能为空')
        if rt.speech_lock.locked():
            raise HTTPException(429, '已有语音正在合成，请稍候。')
        async with rt.speech_lock:
            rt.touch()
            try:
                await rt.ensure_worker()
                req = rt.speech_request(SpeechRequest(input=REFERENCE_TEXT, instructions=body.instruction, design=True))
                response = await rt.http.send(req, stream=True)
                try:
                    if response.status_code != 200:
                        raise HTTPException(response.status_code, '参考音色生成失败，请稍后重试')
                    chunks = []
                    size = 0
                    async for chunk in response.aiter_bytes():
                        if await request.is_disconnected():
                            raise HTTPException(499, 'Client disconnected')
                        size += len(chunk)
                        if size > 24000 * 2 * 20:
                            raise HTTPException(422, '参考音频超过 20 秒，请用简洁的音色描述重试')
                        chunks.append(chunk)
                    entry = rt.voices.save_pcm(b''.join(chunks), body.name, body.instruction)
                    return {'voice':entry}
                finally:
                    await response.aclose()
            except (ValueError, RuntimeError, OSError, httpx.HTTPError) as exc:
                raise HTTPException(503, str(exc)) from exc
            finally:
                rt.touch()

    @app.post('/v1/audio/transcriptions')
    async def transcribe(file:UploadFile=File(...), hotwords:str=Form(default="",max_length=2000)):
        try:
            data=await file.read(MAX_AUDIO_BYTES+1)
            samples=decode_wav(data)
        except (ValueError,RuntimeError) as exc:
            raise HTTPException(400,str(exc)) from exc
        finally:
            await file.close()
        # Worker owns its lock through disconnects; cancellation cannot permit overlap.
        future=asyncio.get_running_loop().run_in_executor(None,app.state.runtime.transcribe,samples,hotwords)
        try:
            return await asyncio.shield(future)
        except asyncio.CancelledError:
            future.add_done_callback(lambda f: None if f.cancelled() else f.exception())
            raise

    @app.post('/v1/audio/speech')
    async def speech(body:SpeechRequest, request:Request):
        if body.response_format!='pcm':
            raise HTTPException(400,'response_format must be pcm')
        if not body.input.strip():
            raise HTTPException(400,'input must not be blank')
        rt=app.state.runtime
        if rt.speech_lock.locked():
            raise HTTPException(429,'已有语音正在合成，请稍候。')
        await rt.speech_lock.acquire()
        rt.touch()
        upstream=None
        try:
            await rt.ensure_worker()
            if await request.is_disconnected():
                raise HTTPException(499,'Client disconnected')
            upstream=await rt.open_speech(body,request)
            if upstream.status_code!=200:
                message=(await upstream.aread()).decode('utf-8','replace')[:600]
                raise HTTPException(upstream.status_code,message)
        except BaseException as exc:
            with anyio.CancelScope(shield=True):
                if upstream is not None:
                    await upstream.aclose()
                rt.touch()
                rt.speech_lock.release()
            if isinstance(exc, (RuntimeError, OSError, httpx.HTTPError)):
                raise HTTPException(503, str(exc)) from exc
            raise

        async def chunks():
            async for chunk in upstream.aiter_bytes():
                if chunk:
                    yield chunk

        async def cleanup():
            try:
                await upstream.aclose()
            finally:
                rt.touch()
                rt.speech_lock.release()
        return OwnedPCMResponse(chunks(),cleanup,media_type='audio/pcm',headers={
            'X-Sample-Rate':'24000','X-Sample-Format':'s16le','Cache-Control':'no-store'})

    return app


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--config',required=True)
    args=parser.parse_args()
    config=json.loads(Path(args.config).read_text(encoding='utf-8-sig'))
    config['_config_path']=str(Path(args.config).resolve())
    import uvicorn
    uvicorn.run(create_app(config),host='127.0.0.1',port=config.get('port',8870),log_level='info')

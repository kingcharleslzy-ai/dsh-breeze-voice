import asyncio
import io
from pathlib import Path
import sys
import httpx
import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient
sys.path.insert(0,str(Path(__file__).parent))
from voice_gateway import create_app,decode_wav,OwnedPCMResponse


def wav(rate=16000,channels=1,seconds=.3):
    buf=io.BytesIO()
    sf.write(buf,np.zeros((int(rate*seconds),channels)),rate,format='WAV',subtype='PCM_16')
    return buf.getvalue()


@pytest.fixture
def client(tmp_path):
    token=tmp_path/'token';token.write_text('x'*48)
    app=create_app({'token_file':str(token),'log_dir':str(tmp_path),'breeze_source':'unused','tts_model':'unused','asr_model':'unused'})
    with TestClient(app) as client:
        yield client


AUTH={'Authorization':'Bearer '+'x'*48}


def test_auth_and_cold_health_do_not_load_gpu(client):
    assert client.get('/health').status_code==401
    r=client.get('/health',headers=AUTH)
    assert r.status_code==200
    assert r.json()['tts']=='unloaded'
    assert r.json()['asr']=='unloaded'


def test_audio_validation(client):
    for value in [b'not audio',wav(rate=48000),wav(channels=2),wav(seconds=.01)]:
        r=client.post('/v1/audio/transcriptions',headers=AUTH,files={'file':('recording.wav',value)})
        assert r.status_code==400
    assert decode_wav(wav()).shape==(4800,)


def test_transcription_contract(client):
    calls=[]
    def transcribe(samples, hotwords=""):
        calls.append(samples.shape)
        return {'text':'你好','language':'zh','duration':.3}
    client.app.state.runtime.transcribe=transcribe
    r=client.post('/v1/audio/transcriptions',headers=AUTH,files={'file':('recording.wav',wav())})
    assert r.json()['text']=='你好'
    assert calls==[(4800,)]


def test_speech_proxy_stream_and_release(client):
    rt=client.app.state.runtime
    async def ready(): pass
    rt.ensure_worker=ready
    def respond(request):
        assert request.url.path=='/v1/audio/speech'
        assert b'text=' in request.content
        return httpx.Response(200,content=b'\x01\x00'*240)
    rt.http=httpx.AsyncClient(transport=httpx.MockTransport(respond))
    r=client.post('/v1/audio/speech',headers=AUTH,json={'input':'你好','response_format':'pcm','design':True})
    assert r.status_code==200
    assert r.headers['x-sample-rate']=='24000'
    assert r.content==b'\x01\x00'*240
    assert not rt.speech_lock.locked()


def test_upstream_error_releases_lock(client):
    rt=client.app.state.runtime
    async def ready(): pass
    rt.ensure_worker=ready
    rt.http=httpx.AsyncClient(transport=httpx.MockTransport(lambda r:httpx.Response(503,text='busy')))
    r=client.post('/v1/audio/speech',headers=AUTH,json={'input':'你好','design':True})
    assert r.status_code==503
    assert not rt.speech_lock.locked()


def test_disconnect_before_iteration_releases_resources():
    cleaned=[]
    async def run():
        async def chunks():
            yield b'never'
        async def cleanup(): cleaned.append(True)
        response=OwnedPCMResponse(chunks(),cleanup)
        async def receive(): return {'type':'http.disconnect'}
        async def send(message): raise ConnectionError('disconnected before first byte')
        try:
            await response({'type':'http','asgi':{'spec_version':'2.4'}},receive,send)
        except Exception:
            pass
    asyncio.run(run())
    assert cleaned==[True]


def test_speech_format_and_blank_rejected(client):
    assert client.post('/v1/audio/speech',headers=AUTH,json={'input':'hi','response_format':'mp3'}).status_code==400
    assert client.post('/v1/audio/speech',headers=AUTH,json={'input':'  '}).status_code==400


def test_warmup_loads_models_and_releases_lock(client):
    rt=client.app.state.runtime
    calls=[]
    async def ready():
        calls.append('tts')
        rt.worker_state='ready'
    def asr(samples):
        calls.append('asr')
        rt.asr=object()
        return {'text':''}
    rt.ensure_worker=ready
    rt.transcribe=asr
    r=client.post('/v1/audio/warmup',headers=AUTH)
    assert r.status_code==200 and r.json()['ready']
    assert calls==['tts','asr']
    assert not rt.speech_lock.locked()


def test_worker_load_failure_is_actionable_and_unlocks(client):
    rt=client.app.state.runtime
    async def fail(): raise RuntimeError('Breeze 模型加载失败')
    rt.ensure_worker=fail
    r=client.post('/v1/audio/speech',headers=AUTH,json={'input':'你好','design':True})
    assert r.status_code==503
    assert 'Breeze' in r.json()['detail']
    assert not rt.speech_lock.locked()


def test_idle_settings_persist_without_overwriting_connection(client,tmp_path):
    rt=client.app.state.runtime
    config_path=tmp_path/'server.json'
    rt.config['_config_path']=str(config_path)
    config_path.write_text(__import__('json').dumps({k:v for k,v in rt.config.items() if not k.startswith('_')}))
    original=__import__('json').loads(config_path.read_text())
    r=client.patch('/v1/settings',headers=AUTH,json={'idle_seconds':300})
    assert r.status_code==200 and r.json()['idle_seconds']==300
    persisted=__import__('json').loads(config_path.read_text())
    assert persisted=={**original,'idle_seconds':300}
    assert client.get('/health',headers=AUTH).json()['idle_seconds']==300
    r=client.patch('/v1/settings',headers=AUTH,json={'idle_seconds':0})
    assert r.status_code==200
    assert client.get('/health',headers=AUTH).json()['idle_remaining_seconds'] is None
    for data in [{'idle_seconds':-1},{'idle_seconds':9000},{'idle_seconds':True},{'idle_seconds':1.5},{'idle_seconds':60,'token_file':'changed'}]:
        assert client.patch('/v1/settings',headers=AUTH,json=data).status_code==422
    assert client.patch('/v1/settings',headers=AUTH,json={'idle_seconds':2}).status_code==400


def test_release_refuses_active_asr_and_unloads_when_idle(client):
    rt=client.app.state.runtime
    rt.asr=object()
    rt.asr_lock.acquire()
    try:
        assert client.post('/v1/models/unload',headers=AUTH).status_code==409
        assert rt.asr is not None
    finally:
        rt.asr_lock.release()
    r=client.post('/v1/models/unload',headers=AUTH)
    assert r.status_code==200 and rt.asr is None
    assert not rt.asr_lock.locked() and not rt.speech_lock.locked()


def test_release_refuses_active_synthesis(client):
    rt=client.app.state.runtime
    asyncio.run(rt.speech_lock.acquire())
    try:
        assert client.post('/v1/models/unload',headers=AUTH).status_code==409
    finally:
        rt.speech_lock.release()


def test_fixed_voice_reuses_identical_reference_every_sentence(client,tmp_path):
    rt=client.app.state.runtime
    async def ready(): pass
    rt.ensure_worker=ready
    voice=rt.voices.save_wav(wav(rate=24000,seconds=3),'稳定测试','描述','原始参考文本')
    rt.config['default_voice_id']=voice['id']
    requests=[]
    def response(req):
        requests.append(req.content)
        return httpx.Response(200,content=b'\x01\x00'*240)
    rt.http=httpx.AsyncClient(transport=httpx.MockTransport(response))
    for text in ['第一句话。','完全不同的第二句话。']:
        assert client.post('/v1/audio/speech',headers=AUTH,json={'input':text}).status_code==200
    audio=rt.voices.get(voice['id'])[1]
    for request in requests:
        assert audio in request
        assert '原始参考文本'.encode() in request
        assert b'name="instruction"' not in request
    assert client.post('/v1/audio/speech',headers=AUTH,json={'input':'test','voice':'../../secret'}).status_code==400
    assert not rt.speech_lock.locked()


def test_missing_reference_fails_explicitly_and_default_persists(client,tmp_path):
    rt=client.app.state.runtime
    async def ready(): pass
    rt.ensure_worker=ready
    assert client.post('/v1/audio/speech',headers=AUTH,json={'input':'test'}).status_code==409
    voice=rt.voices.save_wav(wav(rate=24000,seconds=3),'默认音色','描述','参考文本')
    config_path=tmp_path/'config.json';rt.config['_config_path']=str(config_path)
    response=client.post('/v1/voices/default',headers=AUTH,json={'voice_id':voice['id']})
    assert response.status_code==200
    assert __import__('json').loads(config_path.read_text())['default_voice_id']==voice['id']
    assert client.get('/v1/voices',headers=AUTH).json()['voices'][0]['id']==voice['id']
    assert client.post('/v1/voices/default',headers=AUTH,json={'voice_id':'0'*32}).status_code==400


def test_voice_creation_only_commits_complete_audio_and_releases(client):
    rt=client.app.state.runtime
    async def ready(): pass
    rt.ensure_worker=ready
    rt.http=httpx.AsyncClient(transport=httpx.MockTransport(lambda r:httpx.Response(200,content=b'\x01\x00'*24000*3)))
    response=client.post('/v1/voices',headers=AUTH,json={'name':'新音色','instruction':'亲切女声'})
    assert response.status_code==200
    assert len(rt.voices.list())==1 and not rt.speech_lock.locked()
    rt.http=httpx.AsyncClient(transport=httpx.MockTransport(lambda r:httpx.Response(200,content=b'partial')))
    assert client.post('/v1/voices',headers=AUTH,json={'name':'坏音色','instruction':'亲切女声'}).status_code==503
    assert len(rt.voices.list())==1 and not rt.speech_lock.locked()


def test_recent_cancel_worker_busy_is_retried_before_sending_audio(client):
    rt=client.app.state.runtime
    async def ready(): pass
    rt.ensure_worker=ready
    calls=[]
    def respond(req):
        calls.append(1)
        return httpx.Response(409 if len(calls)==1 else 200,content=b'\x01\x00'*240)
    rt.http=httpx.AsyncClient(transport=httpx.MockTransport(respond))
    r=client.post('/v1/audio/speech',headers=AUTH,json={'input':'打断之后的一句','design':True})
    assert r.status_code==200 and len(calls)==2
    assert not rt.speech_lock.locked()


def test_native_asr_warmup_does_not_load_remote_recognizer(client):
    rt=client.app.state.runtime
    async def ready(): rt.worker_state='ready'
    rt.ensure_worker=ready
    def forbidden(*args): raise AssertionError('must not load remote ASR')
    rt.transcribe=forbidden
    assert client.post('/v1/audio/warmup',headers=AUTH,json={'asr':False}).status_code==200
    assert rt.asr is None

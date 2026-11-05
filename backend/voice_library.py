"""Persistent synthetic reference voices. No user recording is retained here."""
from __future__ import annotations
import io
import json
from pathlib import Path
import re
import secrets
import time
import numpy as np
import soundfile as sf

REFERENCE_TEXT = '你好，很高兴和你聊天。我们可以一起整理思路，讨论工作，也可以轻松聊聊今天发生的事情。'


def atomic_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.' + secrets.token_hex(6) + '.tmp')
    try:
        temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
        temp.replace(path)
    finally:
        temp.unlink(missing_ok=True)


class VoiceLibrary:
    def __init__(self, root):
        self.root = Path(root)
        self.index = self.root / 'index.json'

    def list(self):
        if not self.index.exists():
            return []
        value = json.loads(self.index.read_text(encoding='utf-8'))
        if not isinstance(value, list):
            raise ValueError('音色库索引无效')
        return value

    def get(self, voice_id):
        if not isinstance(voice_id, str) or not re.fullmatch(r'[a-f0-9]{32}', voice_id):
            raise ValueError('音色 ID 无效，请重新选择已保存音色')
        entry = next((x for x in self.list() if x['id'] == voice_id), None)
        if entry is None:
            raise ValueError('未找到已保存音色，请重新选择')
        audio = (self.root / (voice_id + '.wav')).read_bytes()
        return entry, audio

    def save_pcm(self, pcm, name, instruction, text=REFERENCE_TEXT):
        if len(pcm) % 2 or not 24000 * 2 * 2 <= len(pcm) <= 24000 * 2 * 20:
            raise ValueError('参考音频须完整且为 2–20 秒，请重新生成')
        audio = io.BytesIO()
        sf.write(audio, np.frombuffer(pcm, dtype='<i2'), 24000, format='WAV', subtype='PCM_16')
        return self.save_wav(audio.getvalue(), name, instruction, text)

    def save_wav(self, audio, name, instruction, text):
        with sf.SoundFile(io.BytesIO(audio)) as wav:
            duration = wav.frames / wav.samplerate
            if wav.channels != 1 or not 2 <= duration <= 20:
                raise ValueError('参考音频须为 2–20 秒单声道')
        voice_id = secrets.token_hex(16)
        entry = dict(id=voice_id, name=name.strip(), instruction=instruction.strip(), reference_text=text.strip(),
                     duration=round(duration, 3), created_at=time.time())
        if not entry['name'] or not entry['reference_text']:
            raise ValueError('音色名称和参考文本不能为空')
        self.root.mkdir(parents=True, exist_ok=True)
        target = self.root / (voice_id + '.wav')
        target.write_bytes(audio)
        try:
            atomic_json(self.index, [*self.list(), entry])
        except BaseException:
            target.unlink(missing_ok=True)
            raise
        return entry

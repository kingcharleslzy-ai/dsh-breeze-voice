"""Download pinned voice models to the private server directory, never a public service."""
import argparse,json
from pathlib import Path
from huggingface_hub import snapshot_download
p=argparse.ArgumentParser()
p.add_argument('--directory',default=str(Path(__file__).parent/'models'))
a=p.parse_args();base=Path(a.directory)
models=[
 ('BreezeBlue/Breeze-TTS-2','3e28c5151381a722f1d8661b4118c298caa77aa4','breeze-tts-2'),
 ('mobiuslabsgmbh/faster-whisper-large-v3-turbo','0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf','whisper-turbo'),
]
records=[]
for repo,revision,name in models:
 snapshot_download(repo,revision=revision,local_dir=str(base/name),max_workers=4)
 records.append({'repo':repo,'revision':revision,'directory':name})
 (base/'provenance.json').write_text(json.dumps(records,indent=2),encoding='utf-8')
 print('Downloaded '+repo,flush=True)

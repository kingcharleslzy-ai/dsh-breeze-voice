"""Create a new private server config without replacing existing credentials."""
from pathlib import Path
import json
import secrets
import argparse
p=argparse.ArgumentParser()
p.add_argument('--root',default=str(Path(__file__).parent))
a=p.parse_args()
root=Path(a.root).resolve()
config=root/'server.json'
if config.exists():
    raise SystemExit('server.json already exists; inspect before changing it')
token=root/'token.txt'
if not token.exists():
    token.write_text(secrets.token_urlsafe(48),encoding='utf-8')
config.write_text(json.dumps({
    'port':8870,'worker_port':8871,'token_file':str(token),
    'breeze_source':str(root/'upstream'),
    'tts_model':str(root/'models'/'breeze-tts-2'),
    'asr_model':str(root/'models'/'whisper-turbo'),
    'asr_device':'cuda','language':'zh','idle_seconds':600,
    'tts_min_free_mb':11000,'load_timeout_seconds':180,'log_dir':str(root/'logs')
},indent=2),encoding='utf-8')
print('Created private server config and credential; credential value not displayed.')

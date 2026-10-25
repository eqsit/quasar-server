"""Prepare Station config files from a saved quasar.cfg / asound.conf.

Nothing is written to the device. Files land in --out (default: ./station-out).
"""
import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--backup', default='./station-backup', help='dir with quasar.cfg and asound.conf')
parser.add_argument('--out', default='./station-out')
parser.add_argument('--base-url', default='https://quasar.example.com:31117', help='public backend base URL')
parser.add_argument('--route-file', default='./route.token', help='file with the random path prefix')
parser.add_argument('--silent', action='store_true', help='render to fakesink for unattended tests')
args = parser.parse_args()

backup = Path(args.backup)
out = Path(args.out)
root = Path(__file__).resolve().parent.parent
route = (Path(args.route_file) if args.route_file else root / 'secrets/route.token').read_text().strip()
base = args.base_url.rstrip('/') + '/' + route

cfg = json.loads((backup / 'quasar.cfg').read_text())
cfg['common']['backendUrl'] = base + '/quasar.yandex.net'
cfg['aliced']['uniProxyUrl'] = base.replace('https://', 'wss://') + '/uniproxy.alice.yandex.net/uni.ws'
cfg['aliced']['uniProxyQuicUrl'] = ''
cfg['arpc_client']['server_url'] = base + '/rpc.alice.yandex.net'
sound = (backup / 'asound.conf').read_text()

if args.silent:
    cfg['aliced']['jingle'] = False
    for key in ('playCancelEarcon', 'playRecognitionErrorEarcon', 'playStartVoiceInputEarcon', 'playStopRecognitionEarcon'):
        cfg['aliced'][key] = False
    cfg['audioclient']['controller']['playbackParams']['common']['gstProperties']['SINK'] = 'fakesink sync=true'
    sound = sound.replace('playback.pcm "soft_volume"', 'playback.pcm "quasar_silent"', 1)
    sound += ('\npcm.quasar_silent {\n  type route\n  slave.pcm "soft_volume"\n'
              '  slave.channels 2\n  ttable.0.0 0\n  ttable.1.1 0\n}\n')

out.mkdir(parents=True, exist_ok=True)
for name, content in (('station-quasar.cfg', json.dumps(cfg, ensure_ascii=False, indent=2) + '\n'),
                      ('station-asound.conf', sound)):
    path = out / name
    path.write_text(content)
    path.chmod(0o600)
print('Prepared files in', out, '| audio:', 'silent' if args.silent else 'normal')

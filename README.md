# quasar-server

Emulator of the Yandex Station (Quasar) backend. The Station is pointed at this server
through its own `quasar.cfg`, so Alice answers with your LLM, STT and TTS instead of the
Yandex cloud. The firmware stays stock; root ADB is used only to edit the config.

This fork adds a full voice pipeline: Ogg/Opus voice input, VAD endpointing, Whisper STT,
an OpenAI-compatible LLM with tool calling, TTS, music via Tidal, timers/alarms and web
search. Text replies are spoken in parts while the rest of the answer is still generating.

## Requirements

- Linux host, Node.js 22+, pnpm, ffmpeg, PostgreSQL 17 (Docker is fine)
- Python 3.11+ with `services/requirements.lock` in a venv
- Public HTTPS domain with a real certificate (the Station validates TLS)
- Yandex Station with root ADB access (Lite/1 tested; other Quasar devices may differ)

## Services

| Service | Port | Notes |
| --- | --- | --- |
| `quasar-server` (Node) | 31115 backend, 31116 management API | OpenAI-compatible front |
| `quasar-voice` (FastAPI) | 31118 | `/stt` WS, `/processor`, `/v1/audio/*` |
| `quasar-tidal` (Go) | 31119 | Tidal OAuth, queue, audio proxy |
| nginx | 31117 TLS | public entry with a random path prefix |
| PostgreSQL | 55432 | stations, tokens, settings |

`deploy/` contains systemd units, an nginx generator (`configure_proxy.py`) and smoke tests.

## Environment

Secrets live in untracked files: `.env.local` (server), `secrets/voice.env` (providers),
`secrets/postgres.env`, `secrets/route.token` (random URL prefix).

| Variable | Purpose |
| --- | --- |
| `PORT`, `API_PORT`, `BIND_HOST` | Node ports, keep both on loopback |
| `POSTGRES_URL` | database DSN |
| `STT_GIGAAM_URL` | ws URL of the local voice API `/stt` |
| `PROCESSOR_BASIC_URL` | local voice API `/processor` |
| `TTS_OPENAI_BASE_URL`, `TTS_OPENAI_MODEL`, `TTS_OPENAI_VOICE`, `TTS_OPENAI_SPEED` | TTS proxy settings |
| `GROQ_API_KEY`, `GROQ_STT_MODEL` | speech recognition |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_REASONING_EFFORT` | chat model (any OpenAI-compatible API) |
| `TTS_PROVIDER`, `TTS_VOICE` | `inworld`, `edge` or `gemini` |
| `STT_SILENCE_MS` | end-of-speech silence, default 500 ms |
| `STT_SPEC_SILENCE_MS` | speculative ASR start inside that silence, default 300 ms |
| `SERPER_API_KEY` | optional, enables `web_search` / `read_web_pages` |
| `WEATHER_CITY`, `WEATHER_LATITUDE`, `WEATHER_LONGITUDE`, `ASSISTANT_TIMEZONE` | local context |

## Tested providers

| Stage | Recommended | Measured | Notes |
| --- | --- | --- | --- |
| STT | Groq `whisper-large-v3` | 0.2–0.3 s | `turbo` is not faster in practice |
| LLM | `deepseek-v4.1-flash` via an OpenAI-compatible gateway | ~0.2 s to first token | reasoning off/low; any chat model with tool calling works |
| TTS | Inworld `inworld-tts-2-flash` + `OGG_OPUS` | 0.4–0.7 s per part | return Ogg/Opus directly, no local ffmpeg |
| TTS fallback | Edge `ru-RU-SvetlanaNeural` | ~0.5 s | free, needs ffmpeg for Opus |
| Search | Serper | optional | without a key the tools are disabled |

## Station preparation

1. Root the Station and enable ADB (`adb connect <ip>:5555`).
2. Copy `quasar.cfg` and `/etc/asound.conf` from the device.
3. Render new files: `python3 deploy/prepare_station.py --backup <dir> --base-url https://your.host:31117 --route-file secrets/route.token`
4. Push them back, keep a copy of the originals, `sync` and reboot.
5. Never stop `quasar_launcher2`: the hardware watchdog reboots the device.

## Tests

```bash
pnpm run typecheck && pnpm run test && pnpm run build   # TypeScript
python3 -m unittest discover -s tests -p 'test_*.py'    # voice API (needs the venv)
```

`deploy/*_smoke.*` are protocol-level checks: they connect like a Station and verify
ASR, response parts and Ogg/Opus bytes without playing audio on the speaker.

## Security

- No keys in git: `.env.local`, `secrets/`, `dist/`, `.venv/` are ignored.
- The public path prefix is a bearer secret; regenerate it if leaked.
- Logs never contain user audio or API keys.

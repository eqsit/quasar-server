# AGENTS.md

Instructions for coding agents working on this fork.

## Scope

`quasar-server` emulates the Yandex Station backend. Firmware is never modified: the
Station only gets its backend URLs replaced in `quasar.cfg`. Do not add code that patches
system APKs, OTA or the bootloader.

## Layout

- `src/` — Node backend: UniProxy WS, Alice responses, directives, music, storage.
- `services/` — Python voice API: VAD, STT, LLM streaming, tools, TTS, web search.
- `services/tidal/` — Go service for Tidal OAuth, queue and audio proxy.
- `deploy/` — systemd units, nginx generator, station config prep, smoke tests.
- `tests/` — `*.test.ts` (node:test) and `test_*.py` (unittest).

## Build and test

```bash
pnpm run typecheck && pnpm run test && pnpm run build   # dist/main.cjs
python3 -m unittest discover -s tests -p 'test_*.py'
```

The server runs `dist/main.cjs` under systemd; rebuild after changing `src/`.

## Secrets

- Keys live in `.env.local` and `secrets/*` only. Never commit or print them.
- Never log API keys, tokens, audio, or full user utterances.
- `secrets/route.token` is the public URL prefix and is a bearer secret.

## Voice pipeline rules

- Keep the first spoken part short: `services/llm_stream.py` emits complete sentences and
  the backend synthesizes each part separately.
- TTS must return `OGG_OPUS` when the provider supports it (`services/tts_providers.py`);
  ffmpeg is only a fallback for WAV/MP3 providers.
- Endpointing: `STT_SILENCE_MS` (default 500) sets the end of speech, `STT_SPEC_SILENCE_MS`
  (default 300) starts a speculative ASR request that is reused if no new voiced frames
  arrive. Do not raise these without a reason: latency is a product requirement.
- Station replies about itself must be feminine in Russian ("я поняла", "я включила").
- Do not name sources or read URLs unless the user asks.

## Providers

Best measured combinations:

- STT: Groq `whisper-large-v3` (0.2–0.3 s, Russian). `large-v3-turbo` gives no gain.
- LLM: `deepseek-v4.1-flash` through an OpenAI-compatible gateway, reasoning off/low,
  first token ~0.2 s. Any tool-calling chat model works.
- TTS: Inworld `inworld-tts-2-flash`, `audioEncoding=OGG_OPUS`, 48 kbps, `speakingRate`
  limit 0.5–1.5. Free fallback: Edge `ru-RU-SvetlanaNeural`.
- Search: Serper is optional; without `SERPER_API_KEY` the tools stay disabled.

## Deployment

1. Copy sources without `node_modules`, `.venv`, `secrets`, `dist`.
2. Build locally, ship `dist/main.cjs` plus `services/`.
3. `systemctl restart quasar-voice` after Python changes, `quasar-server` after Node ones.
4. Verify: `/health` on 31116 and 31118, then a protocol smoke test.
5. Keep backups before edits; roll back by restoring the previous files.

## Safety

- Never run a factory reset, never write NAND images, never stop `quasar_launcher2`.
- Volume and LED behaviour are user-visible: change them only when asked.
- Any change to the public surface (ports, paths, TLS) must be reversible.

#!/usr/bin/env python3
"""Synthesis naskah multi-baris dengan edge-tts + timing per kata.

Dipakai ttsManager.js lewat /opt/voice-env/bin/python:
    python ttsNarration.py spec.json result.json

spec.json   : {"lines": [{"text": "...", "voice": "id-ID-ArdiNeural"}, ...], "seg_dir": "/tmp/xxx"}
result.json : {"segments": [{"file": "...", "text": "...", "voice": "...", "words": [{"text","start","end"}]}]}

Waktu word boundary dari edge-tts memakai satuan 100 ns relatif ke awal stream audio,
dan dikembalikan apa adanya per segmen; ttsManager.js yang menambahkan offset kumulatif
setelah file-file digabung menjadi satu voiceover.
"""

import asyncio
import json
import sys

import edge_tts

OFFSET_UNIT = 10_000_000  # detik per satuan offset edge-tts
RETRY = 3


async def synth_one(text, voice, out_path):
    last_error = None
    for attempt in range(RETRY):
        words = []
        try:
            communicate = edge_tts.Communicate(text, voice, boundary="WordBoundary")
            with open(out_path, "wb") as handle:
                async for chunk in communicate.stream():
                    kind = chunk["type"]
                    if kind == "audio":
                        handle.write(chunk["data"])
                    elif kind in ("WordBoundary", "SentenceBoundary"):
                        start = chunk["offset"] / OFFSET_UNIT
                        words.append(
                            {
                                "text": chunk.get("text", ""),
                                "start": round(start, 3),
                                "end": round(start + chunk["duration"] / OFFSET_UNIT, 3),
                                "kind": kind,
                            }
                        )
            if words:
                return words
            last_error = "tidak ada word boundary yang diterima"
        except Exception as exc:  # jaringan/HTTP transient
            last_error = str(exc)
        await asyncio.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"edge-tts gagal untuk '{text[:40]}': {last_error}")


async def run(spec):
    segments = []
    for index, line in enumerate(spec["lines"]):
        text = (line.get("text") or "").strip()
        if not text:
            continue
        voice = line.get("voice") or spec.get("voice") or "id-ID-ArdiNeural"
        out_path = f"{spec['seg_dir']}/seg_{index:04d}.mp3"
        words = await synth_one(text, voice, out_path)
        segments.append({"file": out_path, "text": text, "voice": voice, "words": words})
    return segments


def main():
    with open(sys.argv[1], "r", encoding="utf-8") as handle:
        spec = json.load(handle)
    segments = asyncio.run(run(spec))
    with open(sys.argv[2], "w", encoding="utf-8") as handle:
        json.dump({"segments": segments}, handle, ensure_ascii=False)


if __name__ == "__main__":
    main()

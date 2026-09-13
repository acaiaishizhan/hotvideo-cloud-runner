# -*- coding: utf-8 -*-
from __future__ import annotations

import json
import os
import sys
import time

from faster_whisper import WhisperModel


def env(name: str, default: str) -> str:
    return (os.environ.get(name) or default).strip()


def load_model():
    model_name = env("HOTVIDEO_TRANSCRIBE_MODEL", "large-v3")
    device = env("HOTVIDEO_TRANSCRIBE_DEVICE", "auto")
    compute_type = env("HOTVIDEO_TRANSCRIBE_COMPUTE_TYPE", "auto")

    if device == "auto":
        attempts = [
            ("cuda", "float16" if compute_type == "auto" else compute_type),
            ("cpu", "int8" if compute_type == "auto" else compute_type),
        ]
    else:
        attempts = [
            (device, ("float16" if device == "cuda" else "int8") if compute_type == "auto" else compute_type),
        ]

    last_error = None
    for dev, ctype in attempts:
        try:
            t0 = time.time()
            model = WhisperModel(model_name, device=dev, compute_type=ctype)
            return model, {
                "model": model_name,
                "device": dev,
                "compute_type": ctype,
                "load_sec": round(time.time() - t0, 2),
            }
        except Exception as exc:
            last_error = exc
            print(f"load failed: device={dev} compute_type={ctype}: {exc}", file=sys.stderr, flush=True)
    raise RuntimeError(f"failed to load faster-whisper model: {last_error}")


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: transcribe-video-copy.py <audio.wav> <output.json>", file=sys.stderr)
        return 2

    audio_path = sys.argv[1]
    output_path = sys.argv[2]
    language = env("HOTVIDEO_TRANSCRIBE_LANGUAGE", "zh")
    if language == "auto":
        language = None
    beam_size = int(env("HOTVIDEO_TRANSCRIBE_BEAM_SIZE", "5"))
    vad_filter = env("HOTVIDEO_TRANSCRIBE_VAD_FILTER", "0") == "1"

    model, runtime = load_model()
    t0 = time.time()
    segments, info = model.transcribe(
        audio_path,
        language=language,
        word_timestamps=True,
        vad_filter=vad_filter,
        beam_size=beam_size,
        condition_on_previous_text=True,
    )

    tokens = []
    out_segments = []
    texts = []
    for seg in segments:
        seg_words = []
        if seg.words:
            for word in seg.words:
                token = {
                    "text": word.word.strip(),
                    "start_ms": int(round(word.start * 1000)),
                    "end_ms": int(round(word.end * 1000)),
                }
                if token["text"]:
                    tokens.append(token)
                    seg_words.append(token)
        text = (seg.text or "").strip()
        if text:
            texts.append(text)
        out_segments.append({
            "start_ms": int(round(seg.start * 1000)),
            "end_ms": int(round(seg.end * 1000)),
            "text": text,
            "words": seg_words,
        })

    result = {
        "ok": True,
        "language": info.language,
        "duration_ms": int(round((info.duration or 0) * 1000)),
        "elapsed_sec": round(time.time() - t0, 2),
        "runtime": runtime,
        "full_text": "\n".join(texts).strip(),
        "tokens": tokens,
        "segments": out_segments,
    }

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(json.dumps({
        "ok": True,
        "device": runtime["device"],
        "compute_type": runtime["compute_type"],
        "tokens": len(tokens),
        "segments": len(out_segments),
        "elapsed_sec": result["elapsed_sec"],
    }, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

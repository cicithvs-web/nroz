#!/opt/voice-env/bin/python3
import sys
import os
import json
from faster_whisper import WhisperModel

def transcribe(audio_path):
    # Gunakan model "base" dengan int8 quantisation untuk kecepatan CPU maksimal
    model = WhisperModel("base", device="cpu", compute_type="int8")
    segments, info = model.transcribe(audio_path, beam_size=5)
    text = " ".join([seg.text for seg in segments]).strip()
    return {
        "text": text,
        "language": info.language,
        "probability": info.language_probability
    }

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Audio path required"}))
        sys.exit(1)

    audio_file = sys.argv[1]
    if not os.path.exists(audio_file):
        print(json.dumps({"error": f"File not found: {audio_file}"}))
        sys.exit(1)

    try:
        res = transcribe(audio_file)
        print(json.dumps(res))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

"""
Long-running transcription worker for OmniCut.
Loads the Whisper model once, then processes WAV files streamed via stdin.

Protocol:
  - On startup, prints {"ready": true} when model is loaded.
  - Reads one WAV file path per line from stdin.
  - Prints {"text": "..."} JSON for each transcription result.
"""

import sys
import json

def main():
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print(json.dumps({"error": "faster-whisper not installed. Run: pip install faster-whisper"}), flush=True)
        sys.exit(1)

    model = WhisperModel("tiny.en", device="cpu", compute_type="int8")
    print(json.dumps({"ready": True}), flush=True)

    for line in sys.stdin:
        wav_path = line.strip()
        if not wav_path:
            continue
        try:
            segments, _ = model.transcribe(
                wav_path,
                beam_size=1,
                language="en",
                vad_filter=True,
                vad_parameters=dict(min_silence_duration_ms=500),
            )
            text = " ".join(seg.text.strip() for seg in segments)
            print(json.dumps({"text": text}), flush=True)
        except Exception as e:
            print(json.dumps({"text": "", "error": str(e)}), flush=True)


if __name__ == "__main__":
    main()

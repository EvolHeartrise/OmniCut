"""
Long-running transcription worker for OmniCut.
Loads Whisper models once, then processes WAV files streamed via stdin.

Models:
  - small.en  — used for English streams (better accuracy for English)
  - small     — used for non-English streams (multilingual + translation)

Protocol:
  - On startup, prints {"ready": true} when both models are loaded.
  - Reads one JSON object per line from stdin:
    {"wav_path": "...", "language": "ja", "task": "translate"}
    language/task are optional; defaults to English transcription.
  - Prints {"sentences": [{"text": "...", "start": 0.0, "end": 1.5}, ...]} JSON
    with per-sentence timestamps derived from word-level timestamps.
"""

import sys
import json
import os

def _add_cuda_dll_paths():
    """Add NVIDIA pip-installed CUDA library paths so CTranslate2 can find them."""
    try:
        import nvidia.cublas
        import nvidia.cudnn
        for pkg in (nvidia.cublas, nvidia.cudnn):
            bin_dir = os.path.join(pkg.__path__[0], "bin")
            if os.path.isdir(bin_dir):
                os.add_dll_directory(bin_dir)
                os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")
    except ImportError:
        pass

def main():
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print(json.dumps({"error": "faster-whisper not installed. Run: pip install faster-whisper"}), flush=True)
        sys.exit(1)

    _add_cuda_dll_paths()
    model_en = WhisperModel("small.en", device="cuda", compute_type="int8_float32")
    model_multi = WhisperModel("small", device="cuda", compute_type="int8_float32")
    print(json.dumps({"ready": True}), flush=True)

    for line in sys.stdin:
        raw = line.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
            wav_path = req["wav_path"]
            language = req.get("language")
            task = req.get("task", "transcribe")
        except (json.JSONDecodeError, KeyError):
            print(json.dumps({"sentences": [], "error": "invalid JSON input"}), flush=True)
            continue
        try:
            use_english = not language or language == "en"
            model = model_en if use_english else model_multi
            transcribe_kwargs = dict(
                beam_size=1,
                word_timestamps=True,
                vad_filter=True,
                vad_parameters=dict(min_silence_duration_ms=500),
                condition_on_previous_text=False,
                repetition_penalty=1.1,
                no_repeat_ngram_size=3,
                hallucination_silence_threshold=2.0,
                task=task,
                language="en" if use_english else language,
            )
            segments, _ = model.transcribe(wav_path, **transcribe_kwargs)
            # Collect all words across segments
            words = []
            for seg in segments:
                if seg.words:
                    words.extend(seg.words)
            # Group words into sentences by punctuation
            sentences = []
            buf = []
            for w in words:
                buf.append(w)
                if w.word.rstrip().endswith((".", "!", "?")):
                    text = "".join(bw.word for bw in buf).strip()
                    if text:
                        sentences.append({"text": text, "start": buf[0].start, "end": buf[-1].end})
                    buf = []
            # Flush remaining words as a partial (incomplete) sentence
            if buf:
                text = "".join(bw.word for bw in buf).strip()
                if text:
                    sentences.append({"text": text, "start": buf[0].start, "end": buf[-1].end, "partial": True})
            print(json.dumps({"sentences": sentences}), flush=True)
        except Exception as e:
            print(json.dumps({"sentences": [], "error": str(e)}), flush=True)


if __name__ == "__main__":
    main()

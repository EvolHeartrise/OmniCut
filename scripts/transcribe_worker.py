"""
Long-running transcription worker for OmniCut.
Loads Whisper models once, then processes audio via stdin.

Models:
  - small.en  — loaded eagerly; used for English streams (better accuracy)
  - small     — loaded lazily on first non-English request (multilingual + translation)

Device:
  - Automatically detects CUDA availability via CTranslate2.
  - Falls back to CPU (int8) when no GPU is available.

Protocol:
  - On startup, prints {"device": "cuda"|"cpu"} indicating which backend.
  - Prints {"ready": true} when the English model is loaded.
  - Reads one JSON object per line from stdin (binary-safe via stdin.buffer).
  - Two input modes:
    1. File mode: {"wav_path": "...", "task": "transcribe", "beam_size": 1}
    2. PCM mode:  {"pcm_length": 12345, "task": "transcribe", "beam_size": 5}
       Immediately after the JSON line, sends `pcm_length` raw bytes of
       s16le 16kHz mono PCM. The worker reads them, converts to float32,
       and passes the numpy array directly to Whisper (no disk I/O).
  - language/task are optional; defaults to English transcription.
  - Prints {"sentences": [{"text": "...", "start": 0.0, "end": 1.5}, ...]} JSON
    with per-sentence timestamps derived from word-level timestamps.
"""

import sys
import json
import os
import numpy as np

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

def _detect_device():
    """Detect whether CUDA is available, falling back to CPU."""
    try:
        import ctranslate2
        if ctranslate2.get_supported_compute_types("cuda"):
            return "cuda", "int8_float32"
    except Exception:
        pass
    return "cpu", "int8"


def main():
    _add_cuda_dll_paths()
    device, compute_type = _detect_device()

    try:
        from faster_whisper import WhisperModel, BatchedInferencePipeline
    except ImportError:
        print(json.dumps({"error": "faster-whisper not installed. Run: pip install faster-whisper"}), flush=True)
        sys.exit(1)
    print(json.dumps({"device": device}), flush=True)

    # Lazy-load models: English model loads eagerly (always needed),
    # multilingual model loads on first non-English request.
    model_en = WhisperModel("small.en", device=device, compute_type=compute_type)
    batched_en = BatchedInferencePipeline(model=model_en)
    model_multi = None
    batched_multi = None
    print(json.dumps({"ready": True}), flush=True)

    stdin = sys.stdin.buffer  # binary mode for PCM support
    while True:
        raw_line = stdin.readline()
        if not raw_line:
            break  # EOF
        raw = raw_line.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
            language = req.get("language")
            task = req.get("task", "transcribe")
            beam_size = req.get("beam_size", 1)
            pcm_length = req.get("pcm_length")
            wav_path = req.get("wav_path")
        except (json.JSONDecodeError, KeyError):
            print(json.dumps({"sentences": [], "error": "invalid JSON input"}), flush=True)
            continue

        # Read PCM binary data if specified
        audio_input = None
        if pcm_length is not None:
            pcm_data = b""
            remaining = pcm_length
            while remaining > 0:
                chunk = stdin.read(remaining)
                if not chunk:
                    break
                pcm_data += chunk
                remaining -= len(chunk)
            if len(pcm_data) != pcm_length:
                print(json.dumps({"sentences": [], "error": f"PCM read error: expected {pcm_length} bytes, got {len(pcm_data)}"}), flush=True)
                continue
            # Convert s16le PCM to float32 numpy array (what faster-whisper expects)
            audio_input = np.frombuffer(pcm_data, dtype=np.int16).astype(np.float32) / 32768.0
        elif wav_path:
            audio_input = wav_path
        else:
            print(json.dumps({"sentences": [], "error": "missing wav_path or pcm_length"}), flush=True)
            continue

        try:
            use_english = not language or language == "en"
            if use_english:
                batched = batched_en
            else:
                if model_multi is None:
                    model_multi = WhisperModel("small", device=device, compute_type=compute_type)
                    batched_multi = BatchedInferencePipeline(model=model_multi)
                batched = batched_multi
            transcribe_kwargs = dict(
                beam_size=beam_size,
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
            segments, _ = batched.transcribe(audio_input, batch_size=8, **transcribe_kwargs)
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
                        sentences.append({
                            "text": text,
                            "start": buf[0].start,
                            "end": buf[-1].end,
                            "words": [{"word": bw.word, "start": bw.start, "end": bw.end} for bw in buf],
                        })
                    buf = []
            # Flush remaining words as a partial (incomplete) sentence
            if buf:
                text = "".join(bw.word for bw in buf).strip()
                if text:
                    sentences.append({
                        "text": text,
                        "start": buf[0].start,
                        "end": buf[-1].end,
                        "partial": True,
                        "words": [{"word": bw.word, "start": bw.start, "end": bw.end} for bw in buf],
                    })
            print(json.dumps({"sentences": sentences}), flush=True)
        except Exception as e:
            print(json.dumps({"sentences": [], "error": str(e)}), flush=True)


if __name__ == "__main__":
    main()

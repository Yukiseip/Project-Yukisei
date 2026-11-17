import json
import re
import ssl
import sys

ssl._create_default_https_context = ssl._create_unverified_context

# NOTICE:
# Fix PyAV incompatibility where av.open in newer versions rejects metadata_errors.
# Root cause: faster-whisper 1.2.1 hardcodes metadata_errors="ignore" which newer av removed.
# Source: https://github.com/SYSTRAN/faster-whisper/issues/1078
# Removal condition: delete once faster-whisper is updated to support av 14+.
import av
_orig_av_open = av.open
def _safe_av_open(*args, **kwargs):
    try:
        return _orig_av_open(*args, **kwargs)
    except TypeError as err:
        if "metadata_errors" in str(err):
            kwargs.pop("metadata_errors", None)
            return _orig_av_open(*args, **kwargs)
        raise
av.open = _safe_av_open

from faster_whisper import WhisperModel

# Use small model on CPU with int8:
# Ultra-fast (~170ms on Ryzen 5 5600X), high accuracy for Spanish,
# 0 MB VRAM footprint and no CUDA DLL issues.
try:
    model = WhisperModel("small", device="cpu", compute_type="int8")
except Exception:
    model = WhisperModel("base", device="cpu", compute_type="int8")

INITIAL_PROMPT = (
    "Yukisei. Hola Yukisei, eres mi asistente virtual. "
    "Conversación en español claro y natural de México sobre tecnología, "
    "programación, videojuegos y temas cotidianos."
)
HOTWORDS = "Yukisei Yukisei Roxy"

def normalize_transcription(text: str) -> str:
    if not text:
        return ""
    # Normalize variants of Yukisei and common phonetic misrecognitions
    text = re.sub(r'\b[yY]uki\s+[sS]ei\b', 'Yukisei', text)
    text = re.sub(r'\b[yY]uqui\s*[sS]ei\b', 'Yukisei', text)
    text = re.sub(r'\b[yY]uquisei\b', 'Yukisei', text)
    text = re.sub(r'\b[yY]ukisey\b', 'Yukisei', text)
    text = re.sub(r'\b[oO]\s+like\s+o\s+quiz[aá]s\b', 'Hola Yukisei', text, flags=re.IGNORECASE)
    text = re.sub(r'\b[hH]ola\s+yo\s+que\s+s[eé]\b', 'Hola Yukisei', text, flags=re.IGNORECASE)
    return text.strip()

sys.stdout.write("READY\n")
sys.stdout.flush()

for line in sys.stdin:
    raw_line = line.strip()
    if not raw_line:
        continue
    if raw_line == "QUIT":
        break

    req_id = ""
    audio_path = raw_line
    if raw_line.startswith("{"):
        try:
            req = json.loads(raw_line)
            req_id = str(req.get("id", ""))
            audio_path = str(req.get("audio_path", "")).strip()
            if req.get("cmd") == "QUIT":
                break
        except Exception:
            pass

    if not audio_path:
        sys.stdout.write(json.dumps({"id": req_id, "text": "", "error": "Empty audio_path"}) + "\n")
        sys.stdout.flush()
        continue

    try:
        segments, _ = model.transcribe(
            audio_path,
            language="es",
            beam_size=5,
            best_of=5,
            temperature=0.0,
            condition_on_previous_text=False,
            repetition_penalty=1.15,
            no_speech_threshold=0.5,
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=400, speech_pad_ms=200),
            initial_prompt=INITIAL_PROMPT,
            hotwords=HOTWORDS,
        )
        raw_text = " ".join([s.text for s in segments]).strip()
        cleaned_text = normalize_transcription(raw_text)
        sys.stdout.write(json.dumps({"id": req_id, "text": cleaned_text, "error": None}) + "\n")
    except Exception as e:
        sys.stdout.write(json.dumps({"id": req_id, "text": "", "error": str(e)}) + "\n")
    sys.stdout.flush()

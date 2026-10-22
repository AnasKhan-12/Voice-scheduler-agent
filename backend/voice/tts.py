import os, re
from pathlib import Path
import numpy as np
from kokoro_onnx import Kokoro

MODEL_DIR = Path(__file__).resolve().parent.parent / "models"
MODEL_PATH = os.environ.get("KOKORO_MODEL", str(MODEL_DIR / "kokoro-v1.0.onnx"))
VOICES_PATH = os.environ.get("KOKORO_VOICES", str(MODEL_DIR / "voices-v1.0.bin"))
VOICE = os.environ.get("KOKORO_VOICE", "af_heart")
SPEED = 1.2
_kokoro = None

def get_kokoro():
    global _kokoro
    if _kokoro is None:
        _kokoro = Kokoro(MODEL_PATH, VOICES_PATH)
    return _kokoro

MAX_CHARS = 300  # replies are 1-2 short sentences, so this is almost always one call

def _trim(x, thresh=0.01, keep=720):
    """Cut leading/trailing silence, keeping ~30 ms at each end."""
    idx = np.flatnonzero(np.abs(x) > thresh)
    return x[max(idx[0] - keep, 0): idx[-1] + keep] if idx.size else x

def synthesize(text: str):
    kokoro = get_kokoro()
    text = " ".join(text.split())
    # Short reply: one call, no seams. Long reply: split at sentence ends only (never commas).
    pieces = [text] if len(text) <= MAX_CHARS else re.split(r"(?<=[.!?])\s+", text)
    for piece in pieces:
        if not piece.strip():
            continue
        samples, _rate = kokoro.create(piece, voice=VOICE, speed=SPEED, lang="en-us")
        yield _trim(np.asarray(samples, dtype=np.float32))
import os, re
from pathlib import Path
import numpy as np
from kokoro_onnx import Kokoro

MODEL_DIR = Path(__file__).resolve().parent.parent / "models"
MODEL_PATH = os.environ.get("KOKORO_MODEL", str(MODEL_DIR / "kokoro-v1.0.int8.onnx"))
VOICES_PATH = os.environ.get("KOKORO_VOICES", str(MODEL_DIR / "voices-v1.0.bin"))
VOICE = os.environ.get("KOKORO_VOICE", "af_heart")
SPEED = 1.2
SPLIT = re.compile(r"(?<=[.!?,;:])\s+")   # also split at commas so the first piece is short

_kokoro = None

def get_kokoro():
    global _kokoro
    if _kokoro is None:
        _kokoro = Kokoro(MODEL_PATH, VOICES_PATH)
    return _kokoro

def synthesize(text: str):
    kokoro = get_kokoro()
    for piece in SPLIT.split(text):
        piece = piece.strip()
        if not piece:
            continue
        samples, _rate = kokoro.create(piece, voice=VOICE, speed=SPEED, lang="en-us")
        yield np.asarray(samples, dtype=np.float32)
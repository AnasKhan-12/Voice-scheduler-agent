"""Streaming Silero VAD on onnxruntime (no torch needed).

Put the model file at  backend/models/silero_vad.onnx  (or set SILERO_VAD_MODEL to its path).
Download: https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx
"""
import os
from pathlib import Path

import numpy as np

SAMPLE_RATE = 16000
FRAME = 512      # Silero wants 512 samples (32 ms) per step at 16 kHz
CONTEXT = 64     # v5/v6 models also need the last 64 samples of the previous frame

MODEL_DIR = Path(__file__).resolve().parent.parent / "models"
_session = None


def _find_model():
    env = os.environ.get("SILERO_VAD_MODEL")
    candidates = [Path(env)] if env else []
    candidates.append(MODEL_DIR / "silero_vad.onnx")
    for p in candidates:
        if p.is_file():
            return str(p)
    raise FileNotFoundError(
        "Silero VAD model not found. Download silero_vad.onnx from "
        "https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx "
        f"and put it at {MODEL_DIR / 'silero_vad.onnx'} (or set SILERO_VAD_MODEL)."
    )


def _get_session():
    global _session
    if _session is None:
        import onnxruntime
        opts = onnxruntime.SessionOptions()
        opts.inter_op_num_threads = 1
        opts.intra_op_num_threads = 1
        opts.log_severity_level = 4
        _session = onnxruntime.InferenceSession(
            _find_model(), providers=["CPUExecutionProvider"], sess_options=opts
        )
    return _session


class SileroVAD:
    """One instance per connection (it keeps the model's running state)."""

    def __init__(self):
        self.session = _get_session()
        inputs = {i.name: i for i in self.session.get_inputs()}
        self.new_style = "state" in inputs  # v5/v6: "state"; v4: "h" and "c"
        sr_shape = inputs["sr"].shape if "sr" in inputs else []
        self.sr = np.array(SAMPLE_RATE if not sr_shape else [SAMPLE_RATE], dtype=np.int64)
        self.reset()

    def reset(self):
        if self.new_style:
            self.state = np.zeros((2, 1, 128), dtype=np.float32)
            self.context = np.zeros((1, CONTEXT), dtype=np.float32)
        else:
            self.h = np.zeros((2, 1, 64), dtype=np.float32)
            self.c = np.zeros((2, 1, 64), dtype=np.float32)
        self.buf = np.zeros(0, dtype=np.float32)

    def _step(self, frame):
        frame = frame[None, :]
        if self.new_style:
            x = np.concatenate([self.context, frame], axis=1)
            out, self.state = self.session.run(None, {"input": x, "state": self.state, "sr": self.sr})
            self.context = x[:, -CONTEXT:]
        else:
            out, self.h, self.c = self.session.run(
                None, {"input": frame, "sr": self.sr, "h": self.h, "c": self.c}
            )
        return float(np.asarray(out).reshape(-1)[0])

    def feed(self, audio):
        """Add float32 16 kHz audio; returns one speech probability (0..1) per complete 32 ms frame."""
        self.buf = np.concatenate([self.buf, np.asarray(audio, dtype=np.float32)])
        probs = []
        while len(self.buf) >= FRAME:
            frame, self.buf = self.buf[:FRAME], self.buf[FRAME:]
            probs.append(self._step(frame))
        return probs
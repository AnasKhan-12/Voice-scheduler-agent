import numpy as np
from faster_whisper import WhisperModel

MODEL_NAME = "base.en"  # alternatives to try later: "small", "medium.en"

PROMPT = (
    "Doctor's scheduling assistant. Schedule a meeting, book an appointment, "
    "consultation, to-do, reminder, tomorrow, next Monday, 3 PM."
)

_model = None


def get_model():
    global _model
    if _model is None:
        _model = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8",cpu_threads=4)
    return _model

def normalize(audio):
    audio = np.asarray(audio, dtype=np.float32)

    if audio.size == 0:
        return audio

    # Remove DC offset only; do not amplify quiet audio
    audio = audio - np.mean(audio)

    return audio

def transcribe_partial(audio):
    audio = np.asarray(audio, dtype=np.float32)
    if audio.size < 8000:  # under 0.5 s
        return ""
    audio = normalize(audio[-30 * 16000:])
    segments, _ = get_model().transcribe(
        audio, language="en", beam_size=1, vad_filter=False,
        condition_on_previous_text=False, without_timestamps=True)
    return " ".join(s.text.strip() for s in segments).strip()

def transcribe(audio):
    audio = np.asarray(audio, dtype=np.float32)

    if audio.size == 0:
        return ""

    # Check audio energy BEFORE normalization
    rms = float(np.sqrt(np.mean(audio ** 2)))
    peak = float(np.max(np.abs(audio)))

    print(f"Audio RMS: {rms:.5f}, Peak: {peak:.5f}")

    # Reject near-silent recordings
    if rms < 0.005 or peak < 0.02:
        print("DEBUG: Silence detected; skipping transcription")
        return ""

    audio = normalize(audio)

    segments, _ = get_model().transcribe(
        audio,
        language="en",
        beam_size=5,
        vad_filter=True,
        condition_on_previous_text=False,
        no_speech_threshold=0.6,
        log_prob_threshold=-1.0,
    )

    # Keep only reasonably confident speech segments
    valid_text = []

    for segment in segments:
        if (
            segment.text.strip()
            and segment.no_speech_prob < 0.6
            and segment.avg_logprob > -1.0
        ):
            valid_text.append(segment.text.strip())

    return " ".join(valid_text)
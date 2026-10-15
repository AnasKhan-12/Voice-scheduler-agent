import sounddevice as sd
from faster_whisper import WhisperModel

stt = WhisperModel("small", device="cpu", compute_type="int8")

def listen(seconds=5, sr=16000):
    print("Speak now...")
    audio = sd.rec(int(seconds * sr), samplerate=sr, channels=1, dtype="float32")
    sd.wait()
    return audio.flatten()

audio = listen()
segments, _ = stt.transcribe(audio, language="en", beam_size=1, vad_filter=True)
print(" ".join(s.text.strip() for s in segments))
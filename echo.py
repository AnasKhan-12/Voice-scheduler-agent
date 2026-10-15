import warnings
warnings.filterwarnings("ignore")

import sounddevice as sd
from faster_whisper import WhisperModel
from kokoro import KPipeline

# Load models once
stt = WhisperModel("small", device="cpu", compute_type="int8")
tts = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M")

def listen(seconds=5, sr=16000):
    print("Speak now...")
    audio = sd.rec(int(seconds * sr), samplerate=sr, channels=1, dtype="float32")
    sd.wait()
    return audio.flatten()

def transcribe(audio):
    segments, _ = stt.transcribe(audio, language="en", beam_size=1, vad_filter=True)
    return " ".join(s.text.strip() for s in segments)

def speak(text):
    for _, _, audio in tts(text, voice="af_heart"):
        sd.play(audio, 24000)
        sd.wait()

while True:
    text = transcribe(listen())
    if not text:
        print("(nothing heard)")
        continue
    print("You said:", text)
    speak("You said: " + text)
from kokoro import KPipeline
import sounddevice as sd

tts = KPipeline(lang_code="a")
for _, _, audio in tts("Hello, your meeting is at three PM.", voice="af_heart"):
    sd.play(audio, 24000)
    sd.wait()
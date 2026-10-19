import io
import wave
from datetime import datetime
from functools import lru_cache

import numpy as np
from django.http import HttpResponse, JsonResponse
from django.shortcuts import render
from .tools import repo  # the same repository the voice agent uses

def events(request):
    doctor_id = request.GET.get("doctor_id")
    return JsonResponse({
        "events": repo.list_events(doctor_id=doctor_id)
    })

def tasks(request):
    return JsonResponse({"tasks": repo.list_tasks()})

def health(request):
    return JsonResponse({"status": "ok"})


def index(request):
    return render(request, "voice/index.html")

def doctors(request):
    return JsonResponse({"doctors": DOCTORS})


REMINDER_WINDOW_MINUTES = 30  # start alerting this many minutes before an appointment


def reminders(request):
    """Appointments for one doctor that start within the next 30 minutes.

    The server does the clock maths so the browser's timezone never matters.
    """
    doctor_id = request.GET.get("doctor_id")
    if not doctor_id:
        return JsonResponse({"error": "doctor_id is required"}, status=400)

    now = datetime.now()
    upcoming = []
    for e in repo.list_events(doctor_id=doctor_id):
        start = datetime.strptime(e["start"], "%Y-%m-%d %H:%M")
        minutes_until = (start - now).total_seconds() / 60
        if 0 <= minutes_until <= REMINDER_WINDOW_MINUTES:
            upcoming.append({
                "id": e["id"],
                "patient_name": e.get("patient_name") or "a patient",
                "title": e.get("title"),
                "start": e["start"],                      # "YYYY-MM-DD HH:MM"
                "minutes_until": int(minutes_until + 0.999),  # round up: 29.2 -> 30
                # The browser adds this to ITS clock, so snoozes stay correct
                # even if the browser and server are in different timezones.
                "seconds_until": int(minutes_until * 60),
            })
    return JsonResponse({"reminders": upcoming})


# ---- Speak text with the voice agent's own voice (Kokoro) ----
TTS_RATE = 24000        # same rate the voice agent streams at
MAX_SPEAK_CHARS = 300


@lru_cache(maxsize=64)
def _speech_wav(text):
    """Render text to WAV bytes. Cached, so repeats and pre-fetches are instant."""
    from . import tts  # imported lazily so the model only loads when first needed

    pcm = np.concatenate(list(tts.synthesize(text)))
    pcm16 = (np.clip(pcm, -1.0, 1.0) * 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(TTS_RATE)
        w.writeframes(pcm16.tobytes())
    return buf.getvalue()


def speak(request):
    """GET /api/speak/?text=...  ->  audio/wav of the voice agent saying `text`."""
    text = " ".join((request.GET.get("text") or "").split())[:MAX_SPEAK_CHARS]
    if not text:
        return JsonResponse({"error": "text is required"}, status=400)
    try:
        wav = _speech_wav(text)
    except Exception as exc:
        return JsonResponse({"error": str(exc)}, status=500)
    response = HttpResponse(wav, content_type="audio/wav")
    response["Cache-Control"] = "private, max-age=300"
    return response


DOCTORS = [
    {
        "id": "dr_sarah",
        "name": "Dr. Sarah",
        "specialty": "Cardiology",
    },
    {
        "id": "dr_james",
        "name": "Dr. James",
        "specialty": "General medicine",
    },
    {
        "id": "dr_emily",
        "name": "Dr. Emily",
        "specialty": "Dermatology",
    },
]
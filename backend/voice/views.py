from django.http import JsonResponse
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
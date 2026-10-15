from django.http import JsonResponse
from django.shortcuts import render
from .tools import repo  # the same repository the voice agent uses

def events(request):
    return JsonResponse({"events": repo.list_events()})

def tasks(request):
    return JsonResponse({"tasks": repo.list_tasks()})

def health(request):
    return JsonResponse({"status": "ok"})


def index(request):
    return render(request, "voice/index.html")
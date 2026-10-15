from django.contrib import admin
from django.urls import path
from voice import views

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/health/", views.health),
    path("", views.index),
    path("api/health/", views.health),
    path("api/events/", views.events),   # new
    path("api/tasks/", views.tasks),
]
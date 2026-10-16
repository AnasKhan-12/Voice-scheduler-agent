from datetime import datetime, timedelta
from . import gcal
from .repository import SupabaseRepository

repo = SupabaseRepository()


def check_availability(date: str, time: str, duration_minutes: int = 30) -> dict:
    """Check whether a time slot on the doctor's calendar is free.

    Args:
        date: Date as YYYY-MM-DD.
        time: Start time in 24-hour HH:MM.
        duration_minutes: Length of the slot in minutes.
    """
    conflicts = repo.find_conflicts(date, time, duration_minutes)
    return {"available": not conflicts, "conflicts": conflicts}

# need to update conflicts by doctor or patient id 

def create_calendar_event(
    title: str,
    patient_name: str,
    date: str,
    time: str,
    duration_minutes: int = 30,
    doctor_id: str = "",
) -> dict:
    """Create an appointment for a selected doctor.

    Args:
        title: Short appointment description.
        date: Appointment date in YYYY-MM-DD format.
        time: Start time in 24-hour HH:MM format.
        duration_minutes: Appointment duration.
        doctor_id: One of dr_sarah, dr_james, or dr_emily.
    """
    valid_doctors = {"dr_sarah", "dr_james", "dr_emily"}

    if doctor_id not in valid_doctors:
        return {
            "created": False,
            "reason": "A valid doctor must be selected."
        }

    conflicts = repo.find_conflicts(date, time, duration_minutes)

    if conflicts:
        return {
            "created": False,
            "reason": "slot is busy",
            "conflicts": conflicts,
        }

    event = repo.create_event(
        title, date, time, duration_minutes, doctor_id=doctor_id,patient_name=patient_name
    )

    synced = True
    try:
        start = datetime.fromisoformat(f"{date}T{time}")
        google_id = gcal.create_event(
            title,
            start,
            start + timedelta(minutes=duration_minutes),
        )
        repo.set_google_event_id(event["id"], google_id)
    except Exception as exc:
        synced = False
        print("Google Calendar sync failed:", exc)

    return {
        "created": True,
        "event": event,
        "google_calendar_synced": synced,
    }

def reschedule_appointment(
    event_id: str,
    new_date: str,
    new_time: str,
    duration_minutes: int = 30,
) -> dict:
    """Reschedule an existing appointment after the patient confirms.

    Args:
        event_id: Exact appointment ID returned by list_events.
        new_date: New date as YYYY-MM-DD.
        new_time: New start time in 24-hour HH:MM format.
        duration_minutes: Appointment duration in minutes.
    """
    event = repo.get_event_for_rescheduling(event_id)

    if event is None:
        return {
            "rescheduled": False,
            "reason": "Appointment not found.",
        }

    # Check whether the new time conflicts with another appointment.
    conflicts = repo.find_conflicts(
        new_date,
        new_time,
        duration_minutes,
    )

    # Exclude the appointment being rescheduled from the conflict check.
    conflicts = [
        conflict for conflict in conflicts
        if str(conflict["id"]) != str(event_id)
    ]

    if conflicts:
        return {
            "rescheduled": False,
            "reason": "The requested time is unavailable.",
            "conflicts": conflicts,
        }

    try:
        new_start = datetime.fromisoformat(f"{new_date}T{new_time}")
        new_end = new_start + timedelta(minutes=duration_minutes)
    except ValueError:
        return {
            "rescheduled": False,
            "reason": "Invalid date or time format.",
        }

    google_event_id = event.get("google_event_id")
    google_synced = False

    # Update the existing Google Calendar event first.
    if google_event_id:
        try:
            gcal.reschedule_event(
                google_event_id,
                new_start,
                new_end,
            )
            google_synced = True
        except Exception as exc:
            print("Google Calendar rescheduling failed:", exc)
            return {
                "rescheduled": False,
                "reason": "Google Calendar could not update the appointment.",
            }

    # Update the same Supabase row; do not insert a new one.
    updated_event = repo.update_event_times(
        event_id,
        new_start,
        new_end,
    )

    if updated_event is None:
        return {
            "rescheduled": False,
            "reason": (
                "The calendar may have changed, but the database update failed. "
                "Please check both systems before retrying."
            ),
        }

    return {
        "rescheduled": True,
        "event": updated_event,
        "google_calendar_synced": google_synced,
    }

def create_todo(title: str, due: str = "") -> dict:
    """Create a to-do item. Only call after the user confirmed.

    Args:
        title: What needs to be done.
        due: Optional due date and time as YYYY-MM-DDTHH:MM, or empty.
    """
    return {"created": True, "task": repo.create_task(title, due)}


def list_tasks() -> dict:
    """List all to-do items with their ids, due times and status."""
    return {"tasks": repo.list_tasks()}


def update_task(task_id: int, title: str = "", due: str = "") -> dict:
    """Change the title or due time of a task. Leave a field empty to keep it.

    Args:
        task_id: Id of the task, from list_tasks.
        title: New title, or empty.
        due: New due time as YYYY-MM-DDTHH:MM, or empty.
    """
    task = repo.update_task(task_id, title=title, due=due)
    return {"updated": task is not None, "task": task}


def complete_task(task_id: int) -> dict:
    """Mark a task as done.

    Args:
        task_id: Id of the task, from list_tasks.
    """
    task = repo.update_task(task_id, status="done")
    return {"completed": task is not None, "task": task}


def snooze_task(task_id: int, minutes: int = 60) -> dict:
    """Postpone a task's due time by some minutes.

    Args:
        task_id: Id of the task, from list_tasks.
        minutes: How many minutes to postpone.
    """
    task = repo.get_task(task_id)
    if task is None:
        return {"snoozed": False, "reason": "task not found"}
    base = datetime.fromisoformat(task["due"]) if task["due"] else datetime.now()
    new_due = (base + timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M")
    return {"snoozed": True, "task": repo.update_task(task_id, due=new_due)}

def find_appointments(date: str) -> dict:
    """Find appointments scheduled on a date.

    Args:
        date: Appointment date in YYYY-MM-DD format.
    """
    appointments = repo.find_events_on_date(date)

    return {
        "appointments": [
            {
                "id": str(event["id"]),
                "title": event["title"],
                "start": event["start"],
                "end": event["end"],
            }
            for event in appointments
        ]
    }


def cancel_appointment(event_id: str) -> dict:
    """Cancel a specific appointment after the patient has confirmed.

    Args:
        event_id: Exact appointment ID returned by find_appointments.
    """
    event = repo.get_event_for_cancellation(event_id)

    if event is None:
        return {
            "cancelled": False,
            "reason": "Appointment not found. It may already be cancelled."
        }

    google_event_id = event.get("google_event_id")

    # Remove it from Google Calendar first.
    # If this fails, leave the Supabase record intact.
    if google_event_id:
        try:
            gcal.delete_event(google_event_id)
        except Exception as exc:
            print("Google Calendar cancellation failed:", exc)
            return {
                "cancelled": False,
                "reason": "Google Calendar could not confirm the cancellation."
            }

    deleted = repo.delete_event(event_id)

    if not deleted:
        return {
            "cancelled": False,
            "reason": "The appointment could not be removed from the database."
        }

    return {
        "cancelled": True,
        "appointment": {
            "title": event["title"],
            "start": event["start"],
            "end": event["end"],
        }
    }

ALL_TOOLS = [
    check_availability,
    create_calendar_event,
    reschedule_appointment,
    create_todo,
    list_tasks,
    update_task,
    complete_task,
    snooze_task,
    find_appointments,
    cancel_appointment,
]


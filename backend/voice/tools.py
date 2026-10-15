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


def create_calendar_event(title: str, date: str, time: str, duration_minutes: int = 30) -> dict:
    """Create a calendar event such as an appointment. Only call after the user confirmed.
    If google_calendar_synced is false in the result, the event is saved but did not reach
    Google Calendar, so tell the user.

    Args:
        title: Short title, for example 'Consultation with Ali'.
        date: Date as YYYY-MM-DD.
        time: Start time in 24-hour HH:MM.
        duration_minutes: Length in minutes.
    """
    conflicts = repo.find_conflicts(date, time, duration_minutes)
    if conflicts:
        return {"created": False, "reason": "slot is busy", "conflicts": conflicts}

    event = repo.create_event(title, date, time, duration_minutes)

    synced = True
    try:
        start = datetime.fromisoformat(f"{date}T{time}")
        google_id = gcal.create_event(title, start, start + timedelta(minutes=duration_minutes))
        repo.set_google_event_id(event["id"], google_id)
    except Exception as exc:
        synced = False
        print("Google Calendar sync failed:", exc)

    return {"created": True, "event": event, "google_calendar_synced": synced}

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


ALL_TOOLS = [
    check_availability,
    create_calendar_event,
    create_todo,
    list_tasks,
    update_task,
    complete_task,
    snooze_task,
]
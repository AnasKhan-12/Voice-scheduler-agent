import itertools
from datetime import datetime, timedelta
import os

class InMemoryRepository:
    """Temporary storage. Supabase will replace this with the same methods."""

    def __init__(self):
        self.events = []
        self.tasks = []
        self._ids = itertools.count(1)

    def _span(self, date, time, minutes):
        start = datetime.fromisoformat(f"{date}T{time}")
        return start, start + timedelta(minutes=minutes)

    def find_conflicts(self, date, time, minutes):
        start, end = self._span(date, time, minutes)
        return [
            self._public_event(e)
            for e in self.events
            if start < e["end"] and e["start"] < end
        ]

    def create_event(self, title, date, time, minutes):
        start, end = self._span(date, time, minutes)
        event = {"id": next(self._ids), "title": title, "start": start, "end": end}
        self.events.append(event)
        return self._public_event(event)

    def create_task(self, title, due):
        task = {"id": next(self._ids), "title": title, "due": due, "status": "pending"}
        self.tasks.append(task)
        return dict(task)

    def list_tasks(self):
        return [dict(t) for t in self.tasks]

    def update_task(self, task_id, **changes):
        for task in self.tasks:
            if task["id"] == task_id:
                task.update({k: v for k, v in changes.items() if v})
                return dict(task)
        return None

    def get_task(self, task_id):
        for task in self.tasks:
            if task["id"] == task_id:
                return dict(task)
        return None
    def list_events(self):
        return [self._public_event(e) for e in sorted(self.events, key=lambda e: e["start"])]

    @staticmethod
    def _public_event(e):
        return {
            "id": e["id"],
            "title": e["title"],
            "start": e["start"].strftime("%Y-%m-%d %H:%M"),
            "end": e["end"].strftime("%Y-%m-%d %H:%M"),
        }

class SupabaseRepository:
    """Same methods as InMemoryRepository, but stored in Supabase."""

    def __init__(self):
        from supabase import create_client

        self.db = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_KEY"])


    def list_events(self, doctor_id=None):
        today = datetime.now().date().isoformat()

        query = (
            self.db.table("events")
            .select("*")
            .gte("end_time", today)
            .order("start_time")
        )

        if doctor_id:
            query = query.eq("doctor_id", doctor_id)

        rows = query.execute().data
        return [self._event(r) for r in rows]


    @staticmethod
    def _span(date, time, minutes):
        start = datetime.fromisoformat(f"{date}T{time}")
        return start, start + timedelta(minutes=minutes)

    def find_conflicts(self, date, time, minutes):
        start, end = self._span(date, time, minutes)
        rows = (
            self.db.table("events")
            .select("*")
            .lt("start_time", end.isoformat())
            .gt("end_time", start.isoformat())
            .execute()
            .data
        )
        return [self._event(r) for r in rows]

    def create_event(self, title, date, time, minutes,
                    patient_name, doctor_id
                    ):
        start, end = self._span(date, time, minutes)
        row = (
            self.db.table("events")
            .insert({
                "title": title,
                "patient_name": patient_name,
                "doctor_id": doctor_id,
                "start_time": start.isoformat(),
                "end_time": end.isoformat(),
            })
            .execute()
            .data[0]
        )

        return self._event(row)

    def create_task(self, title, due):
        row = (
            self.db.table("tasks")
            .insert({"title": title, "due": due or None})
            .execute()
            .data[0]
        )
        return self._task(row)

    def list_tasks(self):
        rows = self.db.table("tasks").select("*").order("id").execute().data
        return [self._task(r) for r in rows]

    def get_task(self, task_id):
        rows = self.db.table("tasks").select("*").eq("id", task_id).execute().data
        return self._task(rows[0]) if rows else None

    def update_task(self, task_id, **changes):
        changes = {k: v for k, v in changes.items() if v}
        if changes:
            rows = self.db.table("tasks").update(changes).eq("id", task_id).execute().data
        else:
            rows = self.db.table("tasks").select("*").eq("id", task_id).execute().data
        return self._task(rows[0]) if rows else None

    @staticmethod
    def _event(r):
        return {
            "id": r["id"],
            "title": r["title"],
            "patient_name": r.get("patient_name"),
            "doctor_id": r.get("doctor_id"),
            "start": r["start_time"].replace("T", " ")[:16],
            "end": r["end_time"].replace("T", " ")[:16],
        }


    @staticmethod
    def _task(r):
        return {
            "id": r["id"],
            "title": r["title"],
            "due": (r["due"] or "")[:16],
            "status": r["status"],
        }

    def set_google_event_id(self, event_id, google_id):
        self.db.table("events").update({"google_event_id": google_id}).eq("id", event_id).execute()

    # to find appointments on a given day
    def find_events_on_date(self, date):
        """Find appointments starting on a particular date."""
        from datetime import date as date_type, timedelta

        selected_date = date_type.fromisoformat(date)
        next_date = selected_date + timedelta(days=1)

        rows = (
            self.db.table("events")
            .select("*")
            .gte("start_time", selected_date.isoformat())
            .lt("start_time", next_date.isoformat())
            .order("start_time")
            .execute()
            .data
        )

        return [
            {
                **self._event(row),
                "google_event_id": row.get("google_event_id"),
            }
            for row in rows
        ]

    def get_event(self, event_id):
        rows = (
            self.db.table("events")
            .select("*")
            .eq("id", event_id)
            .execute()
            .data
        )
    #to remove/ delete a meeting
    def delete_event(self, event_id):
        """Delete an appointment from Supabase."""
        result = (
            self.db.table("events")
            .delete()
            .eq("id", event_id)
            .execute()
        )
        return bool(result.data)


    def get_event_for_cancellation(self, event_id):
        """Retrieve one appointment and its Google Calendar ID."""
        rows = (
            self.db.table("events")
            .select("*")
            .eq("id", event_id)
            .execute()
            .data
        )

        if not rows:
            return None

        row = rows[0]

        return {
            **self._event(row),
            "google_event_id": row.get("google_event_id"),
        }

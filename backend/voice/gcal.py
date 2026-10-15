import os
from pathlib import Path

import tzlocal
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

SCOPES = ["https://www.googleapis.com/auth/calendar.events"]
TOKEN_PATH = Path(__file__).resolve().parent.parent / "token.json"
TIMEZONE = os.environ.get("APP_TIMEZONE") or tzlocal.get_localzone_name()


def _service():
    creds = Credentials.from_authorized_user_file(str(TOKEN_PATH), SCOPES)
    if not creds.valid:
        if creds.expired and creds.refresh_token:
            creds.refresh(Request())
            TOKEN_PATH.write_text(creds.to_json())
        else:
            raise RuntimeError("Google sign-in expired. Run: python google_auth.py")
    return build("calendar", "v3", credentials=creds)


def create_event(title, start, end):
    """Create an event in the primary calendar and return its Google id."""
    body = {
        "summary": title,
        "start": {"dateTime": start.isoformat(), "timeZone": TIMEZONE},
        "end": {"dateTime": end.isoformat(), "timeZone": TIMEZONE},
    }
    event = _service().events().insert(calendarId="primary", body=body).execute()
    return event["id"]
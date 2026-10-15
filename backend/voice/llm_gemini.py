import os
from datetime import datetime

from google import genai
from google.genai import types

from . import tools

MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.8-flash")
THINKING = os.environ.get("GEMINI_THINKING", "low")  # try "minimal" for even faster


def system_prompt():
    now = datetime.now().strftime("%A, %d %B %Y, %H:%M")
    return f"""You are a voice scheduling assistant for a doctor.
Current date and time: {now}. Use it to resolve words like today, tomorrow and next Monday.

Rules:
- Your replies are spoken aloud. Keep them to one or two short sentences.
- Plain spoken English only. No markdown, lists, symbols or emojis.
- Say times naturally, for example 3 PM, not 15:00.
- Before creating or changing anything, repeat the details and ask for confirmation. Only call a creating tool after the user says yes.
- create_calendar_event already checks for conflicts, so do not call check_availability before booking. Use check_availability only when the user asks whether a time is free.
- If a detail is missing, such as the time, ask one short question.
- After a tool runs, briefly say what happened."""


class Agent:
    """One conversation. Keeps its own history."""

    def __init__(self):
        self.client = genai.Client()  # reads GEMINI_API_KEY; must be kept on self
        self.chat = self.client.chats.create(
            model=MODEL,
            config=types.GenerateContentConfig(
                system_instruction=system_prompt(),
                tools=tools.ALL_TOOLS,
                thinking_config=types.ThinkingConfig(thinking_level=THINKING),
            ),
        )

    def reply(self, text: str) -> str:
        response = self.chat.send_message(text)
        return response.text or "Sorry, I did not catch that."
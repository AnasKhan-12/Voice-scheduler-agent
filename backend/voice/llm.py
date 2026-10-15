import inspect
import json
import os
from datetime import datetime
import time
from groq import Groq

from . import tools

MODEL = os.environ.get("GROQ_MODEL", "openai/gpt-oss-20b")
MAX_STEPS = 5  # safety limit on tool-call rounds per message
TYPE_MAP = {str: "string", int: "integer", float: "number", bool: "boolean"}


def system_prompt():
    now = datetime.now().strftime("%A, %d %B %Y, %H:%M")
    return f"""You are a voice scheduling assistant for a doctor.
Current date and time: {now}. Use it to resolve words like today, tomorrow and next Monday.

Rules:
- Your replies are spoken aloud. Use one short sentence when you can, two at most.
- Plain spoken English only. No markdown, lists, symbols or emojis.
- Say times naturally, for example 3 PM, not 15:00.
- Before creating or changing anything, repeat the details and ask for confirmation. Only call a creating tool after the user says yes.
- create_calendar_event already checks for conflicts, so do not call check_availability before booking. Use check_availability only when the user asks whether a time is free.
- If a detail is missing, such as the time, ask one short question.
- After a tool runs, briefly say what happened."""


# ---- Turn the plain Python functions in tools.py into tool schemas ----
def _param_docs(fn):
    """Read the 'name: description' lines from a docstring's Args section."""
    docs, in_args = {}, False
    for line in (fn.__doc__ or "").splitlines():
        s = line.strip()
        if s == "Args:":
            in_args = True
        elif in_args and ":" in s:
            name, desc = s.split(":", 1)
            docs[name.strip()] = desc.strip()
    return docs


def build_schema(fn):
    docs = _param_docs(fn)
    props, required = {}, []
    for name, p in inspect.signature(fn).parameters.items():
        props[name] = {"type": TYPE_MAP.get(p.annotation, "string"), "description": docs.get(name, "")}
        if p.default is inspect.Parameter.empty:
            required.append(name)
    description = " ".join((fn.__doc__ or "").split("Args:")[0].split())
    return {
        "type": "function",
        "function": {
            "name": fn.__name__,
            "description": description,
            "parameters": {"type": "object", "properties": props, "required": required},
        },
    }


FUNCTIONS = {fn.__name__: fn for fn in tools.ALL_TOOLS}
SCHEMAS = [build_schema(fn) for fn in tools.ALL_TOOLS]


class Agent:
    """One conversation. Keeps its own history."""

    def __init__(self):
        self.client = Groq()  # reads GROQ_API_KEY from the environment
        self.messages = [{"role": "system", "content": system_prompt()}]

    def _run_tool(self, call):
        fn = FUNCTIONS.get(call.function.name)
        if fn is None:
            return {"error": f"unknown tool {call.function.name}"}
        try:
            params = inspect.signature(fn).parameters
            args = json.loads(call.function.arguments or "{}")
            args = {k: v for k, v in args.items() if k in params}
            for k, v in args.items():  # the model sometimes sends numbers as text
                if params[k].annotation in (int, float) and isinstance(v, str):
                    args[k] = params[k].annotation(v)
            return fn(**args)
        except Exception as exc:
            return {"error": str(exc)}

    def reply(self, text: str) -> str:
        self.messages.append({"role": "user", "content": text})
        for step in range(MAX_STEPS):
            t0 = time.perf_counter()
            resp = self.client.chat.completions.create(
                model=MODEL,
                messages=self.messages,
                tools=SCHEMAS,
                tool_choice="auto",
                temperature=0.2,
            )
            usage = resp.usage
            print(
                f"GROQ call {step + 1}: {time.perf_counter() - t0:.1f}s, model {MODEL}, "
                f"tokens in/out {getattr(usage, 'prompt_tokens', '?')}/{getattr(usage, 'completion_tokens', '?')}"
            )
            msg = resp.choices[0].message

            if not msg.tool_calls:
                answer = msg.content or "Sorry, I did not catch that."
                self.messages.append({"role": "assistant", "content": answer})
                return answer

            assistant = {
                "role": "assistant",
                "tool_calls": [
                    {
                        "id": c.id,
                        "type": "function",
                        "function": {"name": c.function.name, "arguments": c.function.arguments},
                    }
                    for c in msg.tool_calls
                ],
            }
            if msg.content:
                assistant["content"] = msg.content
            self.messages.append(assistant)

            for c in msg.tool_calls:
                t1 = time.perf_counter()
                result = self._run_tool(c)
                print(f"TOOL {c.function.name}: {time.perf_counter() - t1:.1f}s")
                self.messages.append(
                    {"role": "tool", "tool_call_id": c.id, "content": json.dumps(result)}
                )
        return "Sorry, that took too many steps. Please try again."
import { useCallback, useEffect, useRef, useState } from "react";
import "./ReminderBell.css";

const POLL_MS = 30_000; // how often we ask Django for upcoming appointments
const TICK_MS = 5_000; // how often we re-check snoozes
const SNOOZE_OPTIONS = [5, 10, 30];

// "2026-10-16 15:30" -> Date (local time, same clock the server uses)
const parseStart = (s) => new Date(s.replace(" ", "T"));
const formatTime = (s) =>
  parseStart(s).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

// Turn what the doctor said into an action, or null if we didn't understand.
function parseAnswer(text) {
  const t = text.toLowerCase();
  if (/\b(done|dismiss|okay|ok|got it|stop|no)\b/.test(t)) return { type: "done" };
  if (/\b(5|five)\b/.test(t)) return { type: "snooze", minutes: 5 };
  if (/\b(10|ten)\b/.test(t)) return { type: "snooze", minutes: 10 };
  if (/\b(30|thirty)\b/.test(t)) return { type: "snooze", minutes: 30 };
  return null;
}

/**
 * Bell icon with a red dot when the doctor has an appointment starting
 * within 30 minutes. Clicking it opens the reminder, speaks it aloud and
 * asks whether to snooze (5 / 10 / 30 min) or mark it done.
 *
 * Usage:  <ReminderBell doctorId="dr_sarah" />
 */
export default function ReminderBell({ doctorId }) {
  const [reminders, setReminders] = useState([]);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [listening, setListening] = useState(false);

  // Snoozes / dismissals survive a page refresh (per doctor).
  const storeKey = `reminder-state:${doctorId}`;
  const [state, setState] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(storeKey)) || { snoozed: {}, done: [] };
    } catch {
      return { snoozed: {}, done: [] };
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(storeKey, JSON.stringify(state));
    } catch {}
  }, [state, storeKey]);

  const recognitionRef = useRef(null);
  const retriesRef = useRef(0); // "didn't catch that" re-prompts, capped at 1

  // ---- fetch upcoming appointments ----
  useEffect(() => {
    if (!doctorId) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/reminders/?doctor_id=${encodeURIComponent(doctorId)}`);
        const data = await res.json();
        if (!cancelled) setReminders(data.reminders || []);
      } catch (err) {
        console.error("Could not load reminders", err);
      }
    };
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [doctorId]);

  // ---- clock tick so snoozed reminders come back on time ----
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  // A reminder is "active" if it is not done and not currently snoozed.
  const active = reminders.filter(
    (r) => !state.done.includes(r.id) && (state.snoozed[r.id] || 0) <= now
  );
  const current = active[0];

  // ---- voice ----
  const stopVoice = useCallback(() => {
    window.speechSynthesis?.cancel();
    recognitionRef.current?.abort?.();
    recognitionRef.current = null;
    setListening(false);
  }, []);

  const respond = useCallback(
    (reminder, action) => {
      stopVoice();
      if (action.type === "done") {
        setState((s) => ({ ...s, done: [...s.done, reminder.id] }));
      } else {
        // Never snooze past the appointment start - ring at the start time instead.
        const until = Math.min(
          Date.now() + action.minutes * 60_000,
          parseStart(reminder.start).getTime()
        );
        setState((s) => ({ ...s, snoozed: { ...s.snoozed, [reminder.id]: until } }));
      }
      setNow(Date.now());
    },
    [stopVoice]
  );

  const listenForAnswer = useCallback(
    (reminder) => {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) return; // buttons still work
      const rec = new SR();
      rec.lang = "en-US";
      rec.interimResults = false;
      rec.maxAlternatives = 3;
      rec.onstart = () => setListening(true);
      rec.onend = () => setListening(false);
      rec.onerror = () => setListening(false);
      rec.onresult = (e) => {
        for (const alt of e.results[0]) {
          const action = parseAnswer(alt.transcript);
          if (action) return respond(reminder, action);
        }
        // Didn't catch it - ask once more, then leave it to the buttons.
        if (retriesRef.current++ < 1) {
          speak(reminder, "Sorry, please say done, five, ten, or thirty minutes.");
        }
      };
      recognitionRef.current = rec;
      try {
        rec.start();
      } catch {}
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [respond]
  );

  const speak = useCallback(
    (reminder, text) => {
      if (!("speechSynthesis" in window)) return;
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.0;
      u.onend = () => listenForAnswer(reminder);
      window.speechSynthesis.speak(u);
    },
    [listenForAnswer]
  );

  const handleBellClick = () => {
    if (open) {
      stopVoice();
      setOpen(false);
      return;
    }
    setOpen(true);
    retriesRef.current = 0;
    if (current) {
      const mins = Math.max(
        0,
        Math.ceil((parseStart(current.start).getTime() - Date.now()) / 60_000)
      );
      speak(
        current,
        `You have a meeting with ${current.patient_name} at ${formatTime(current.start)}, ` +
          `in ${mins} minutes. Would you like to snooze for 5, 10, or 30 minutes, or mark it done?`
      );
    }
  };

  // Stop talking if the component goes away.
  useEffect(() => stopVoice, [stopVoice]);

  return (
    <div className="reminder-bell">
      <button
        className="reminder-bell__button"
        onClick={handleBellClick}
        aria-label={
          active.length ? `${active.length} upcoming appointment reminder` : "Reminders"
        }
        aria-expanded={open}
      >
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
             strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {active.length > 0 && <span className="reminder-bell__dot" />}
      </button>

      {open && (
        <div className="reminder-bell__panel" role="dialog" aria-label="Appointment reminders">
          {!current ? (
            <p className="reminder-bell__empty">No upcoming appointments in the next 30 minutes.</p>
          ) : (
            <>
              <p className="reminder-bell__message">
                You have a meeting with <strong>{current.patient_name}</strong> at{" "}
                <strong>{formatTime(current.start)}</strong>.
              </p>
              <p className="reminder-bell__sub">
                {listening ? "Listening… say done, 5, 10 or 30" : "Snooze or mark as done?"}
              </p>
              <div className="reminder-bell__actions">
                {SNOOZE_OPTIONS.map((m) => (
                  <button key={m} onClick={() => respond(current, { type: "snooze", minutes: m })}>
                    {m} min
                  </button>
                ))}
                <button
                  className="reminder-bell__done"
                  onClick={() => respond(current, { type: "done" })}
                >
                  Done
                </button>
              </div>
              {active.length > 1 && (
                <p className="reminder-bell__more">+{active.length - 1} more upcoming</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

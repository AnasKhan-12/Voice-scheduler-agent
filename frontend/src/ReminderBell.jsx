import { useCallback, useEffect, useRef, useState } from "react";
import "./ReminderBell.css";

const POLL_MS = 10_000; // how often we ask Django for upcoming appointments (so the 30-minute alert is on time)
const TICK_MS = 1_000; // how often we re-check snoozes (so a snooze ends on time)
const SNOOZE_OPTIONS = [10, 20]; // minutes

// "2026-10-16 15:30" -> Date. Only used to DISPLAY the clinic's wall-clock time.
const parseStart = (s) => new Date(s.replace(" ", "T"));
const formatTime = (s) =>
  parseStart(s).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
// Clock time for a timestamp in ms (used to tell the doctor exactly when the reminder comes back).
const formatClock = (ms) =>
  new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

// Whole minutes until the appointment (rounded up, never negative).
const minutesLeft = (r, now) => Math.max(0, Math.ceil((r.startAt - now) / 60_000));

const minutesPhrase = (mins) =>
  mins <= 0 ? "right now" : mins === 1 ? "in 1 minute" : `in ${mins} minutes`;

// What the voice agent says when the bell is clicked.
const spokenMessage = (r, mins) =>
  `You have an appointment with ${r.patient_name} ${minutesPhrase(mins)}. ` +
  `Would you like to snooze for 10 or 20 minutes, or mark it done?`;

// The voice agent's own Kokoro voice, rendered by Django.
const speakUrl = (text) => `/api/speak/?text=${encodeURIComponent(text)}`;

// Turn what the doctor said into an action, or null if we didn't understand.
function parseAnswer(text) {
  const t = text.toLowerCase();
  if (/\b(done|dismiss|okay|ok|got it|stop|no)\b/.test(t)) return { type: "done" };
  if (/\b(10|ten)\b/.test(t)) return { type: "snooze", minutes: 10 };
  if (/\b(20|twenty)\b/.test(t)) return { type: "snooze", minutes: 20 };
  return null;
}

/**
 * Bell icon with a red dot when the doctor has an appointment starting
 * within 30 minutes. Clicking it opens the reminder, has the voice agent
 * speak it aloud, and offers Snooze 10 / Snooze 20 / Done (by tapping or
 * by saying "ten", "twenty" or "done").
 *
 * Usage:  <ReminderBell key={doctorId} doctorId="dr_sarah" />
 */
export default function ReminderBell({ doctorId }) {
  const [reminders, setReminders] = useState([]);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);

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
  const audioRef = useRef(null);
  const speechIdRef = useRef(0); // bumping this cancels callbacks of any older utterance
  const retriesRef = useRef(0); // "didn't catch that" re-prompts, capped at 1
  // Alerts already shown ("id:0" = first 30-minute alert, "id:<until>" = after a snooze). Saved with the
  // rest of the state so a page refresh doesn't repeat an alert that was already shown.
  const alertedRef = useRef(new Set(state.alerted || []));

  // ---- fetch upcoming appointments ----
  useEffect(() => {
    if (!doctorId) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/reminders/?doctor_id=${encodeURIComponent(doctorId)}`);
        const data = await res.json();
        if (cancelled) return;
        const fetchedAt = Date.now();
        setReminders(
          (data.reminders || []).map((r) => ({
            ...r,
            // Start time on the browser's clock, based on the server's "seconds until".
            startAt:
              r.seconds_until != null
                ? fetchedAt + r.seconds_until * 1000
                : parseStart(r.start).getTime(),
          }))
        );
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
  // When everything is snoozed: the soonest time a reminder will come back.
  const nextSnoozeAt = reminders
    .filter((r) => !state.done.includes(r.id) && (state.snoozed[r.id] || 0) > now)
    .map((r) => state.snoozed[r.id])
    .sort((a, b) => a - b)[0];
  const mins = current ? minutesLeft(current, now) : null;

  // ---- voice ----
  const stopVoice = useCallback(() => {
    speechIdRef.current++; // any pending "finished speaking" callback is now stale
    const audio = audioRef.current;
    if (audio) {
      audio.onended = audio.onerror = null;
      audio.pause();
      audioRef.current = null;
    }
    window.speechSynthesis?.cancel();
    recognitionRef.current?.abort?.();
    recognitionRef.current = null;
    setListening(false);
    setSpeaking(false);
  }, []);

  const respond = useCallback(
    (reminder, action) => {
      stopVoice();
      if (action.type === "done") {
        setState((s) => ({ ...s, done: [...s.done, reminder.id] }));
      } else {
        // Ring again after the snooze, but never later than 1 minute before the
        // appointment starts (and never sooner than 1 minute from now).
        const t = Date.now();
        const until = Math.min(
          t + action.minutes * 60_000,
          Math.max(reminder.startAt - 60_000, t + 60_000)
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
          speak(reminder, "Sorry, please say ten minutes, twenty minutes, or done.");
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

  // Speak `text` with the voice agent's voice; when finished, listen for the answer.
  const speak = useCallback(
    (reminder, text) => {
      stopVoice();
      const id = ++speechIdRef.current;
      const finished = () => {
        if (speechIdRef.current !== id) return; // superseded or cancelled
        setSpeaking(false);
        listenForAnswer(reminder);
      };

      // Fallback if the server voice is unavailable: the browser's built-in voice.
      let usedFallback = false;
      const fallback = () => {
        if (usedFallback || speechIdRef.current !== id) return;
        usedFallback = true;
        if (!("speechSynthesis" in window)) return setSpeaking(false);
        const u = new SpeechSynthesisUtterance(text);
        u.onend = finished;
        window.speechSynthesis.speak(u);
      };

      const audio = new Audio(speakUrl(text));
      audioRef.current = audio;
      audio.onended = finished;
      audio.onerror = fallback;
      setSpeaking(true);
      audio.play().catch(fallback);
    },
    [stopVoice, listenForAnswer]
  );

  // Automatic alert: the moment a reminder becomes active (30 minutes before the appointment, and again
  // when a snooze ends) open the panel and speak it, with no click on the bell needed.
  useEffect(() => {
    if (!current) return;
    const key = `${current.id}:${state.snoozed[current.id] || 0}`;
    if (alertedRef.current.has(key)) return; // already alerted for this one
    alertedRef.current.add(key);
    setState((s) => ({ ...s, alerted: [...(s.alerted || []), key] }));
    retriesRef.current = 0;
    setOpen(true);
    speak(current, spokenMessage(current, minutesLeft(current, Date.now())));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, state.snoozed, speak]);

  const handleBellClick = () => {
    if (open) {
      stopVoice();
      setOpen(false);
      return;
    }
    setOpen(true);
    retriesRef.current = 0;
    // One timestamp for both, so the panel and the voice always say the same number.
    const t = Date.now();
    setNow(t);
    if (current) speak(current, spokenMessage(current, minutesLeft(current, t)));
  };

  // Stop talking if the component goes away.
  useEffect(() => stopVoice, [stopVoice]);

  const status = speaking
    ? "Speaking…"
    : listening
    ? "Listening… say 10, 20 or done"
    : "Snooze or mark as done?";

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
            <p className="reminder-bell__empty">
              {nextSnoozeAt
                ? `Snoozed. I'll remind you again at ${formatClock(nextSnoozeAt)}.`
                : "No upcoming appointments in the next 30 minutes."}
            </p>
          ) : (
            <>
              <p className="reminder-bell__message">
                You have an appointment with <strong>{current.patient_name}</strong>{" "}
                {mins <= 0 ? (
                  <strong>right now</strong>
                ) : (
                  <>
                    in <strong>{mins} {mins === 1 ? "min" : "mins"}</strong>
                  </>
                )}{" "}
                ({formatTime(current.start)}).
              </p>
              <p className="reminder-bell__sub" aria-live="polite">{status}</p>
              <div className="reminder-bell__actions">
                {SNOOZE_OPTIONS.map((m) => (
                  <button key={m} onClick={() => respond(current, { type: "snooze", minutes: m })}>
                    Snooze {m} min
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
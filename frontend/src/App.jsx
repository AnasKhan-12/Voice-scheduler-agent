import { useEffect, useRef, useState } from "react";
import { useVoiceAgent } from "./useVoiceAgent.js";
import DoctorsPage from "./DoctorsPage.jsx";

const LABEL = {
  off: "Ready when you are",
  connecting: "Connecting",
  listening: "Listening",
  hearing: "Hearing you",
  thinking: "Thinking",
  speaking: "Speaking",
};

const HINT = {
  off: "Start the call, then talk normally. Pause and the agent replies.",
  connecting: "Allow the microphone if your browser asks.",
  listening: "Try: book a consultation tomorrow at 3 PM.",
  hearing: "Keep going. A short pause ends your turn.",
  thinking: "Checking your calendar.",
  speaking: "The mic is paused while the agent speaks.",
};

const SUGGESTIONS = ["Is tomorrow at 3 PM free?", "Add a to-do to call Sara", "List my tasks"];

const ICONS = {
  mic: "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3ZM19 10v2a7 7 0 0 1-14 0v-2M12 19v3",
  micOff: "M2 2l20 20M18.9 13.2A7 7 0 0 0 19 12v-2M5 10v2a7 7 0 0 0 12 5M15 9.3V5a3 3 0 0 0-5.7-1.3M9 9v3a3 3 0 0 0 5.1 2.1M12 19v3",
  send: "m22 2-7 20-4-9-9-4ZM22 2 11 13",
  close: "M18 6 6 18M6 6l12 12",
};

function Icon({ name }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

function Orb({ phase, elRef }) {
  return (
    <div className={`orb orb--${phase}`} ref={elRef} aria-hidden="true">
      <span className="orb__ripple" />
      <span className="orb__ripple orb__ripple--b" />
      <span className="orb__halo" />
      <span className="orb__ring" />
      <span className="orb__core" />
    </div>
  );
}

function Transcript({ messages, partial, live, onPick }) {
  const box = useRef(null);
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [messages, partial]);

  if (!messages.length && !partial) {
    return (
      <div className="empty">
        <p>Nothing said yet. Speak, or tap a request to send it as text.</p>
        <div className="chips">
          {SUGGESTIONS.map((s) => (
            <button key={s} className="chip" disabled={!live} onClick={() => onPick(s)}>{s}</button>
          ))}
        </div>
      </div>
    );
  }
  const who = { you: "You", agent: "Agent", error: "Problem" };
  return (
    <ol className="lines" ref={box} aria-live="polite">
      {messages.map((m) => (
        <li key={m.id} className={`line line--${m.role}`}>
          <span className="line__who">{who[m.role]}</span>
          <p>{m.text}</p>
        </li>
      ))}
      {partial && (
        <li className="line line--you line--partial" aria-hidden="true">
          <span className="line__who">You</span>
          <p>{partial}…</p>
        </li>
      )}
    </ol>
  );
}

// ---- Schedule panel (reads /api/events/ and /api/tasks/ from Django) ----
const toDate = (s) => new Date(s.replace(" ", "T"));
const hm = (d) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
function dayLabel(d) {
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 864e5);
  if (d.toDateString() === now.toDateString()) return "Today";
  if (d.toDateString() === tomorrow.toDateString()) return "Tomorrow";
  return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
}

function Schedule({ refreshKey }) {
  const [events, setEvents] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [e, t] = await Promise.all([fetch("/api/events/"), fetch("/api/tasks/")]);
        if (!e.ok || !t.ok) throw new Error("not available");
        const [ej, tj] = await Promise.all([e.json(), t.json()]);
        if (cancelled) return;
        setEvents(ej.events);
        setTasks(tj.tasks);
        setFailed(false);
      } catch {
        if (!cancelled) setFailed(true);
      }
    }
    load();
    const timer = setInterval(load, 30000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [refreshKey]);

  if (failed) {
    return <p className="muted">The schedule appears here once the two small Django endpoints are added.</p>;
  }

  const today = new Date().setHours(0, 0, 0, 0);
  const upcoming = events
    .map((e) => ({ ...e, s: toDate(e.start), f: toDate(e.end) }))
    .filter((e) => e.f >= today)
    .sort((a, b) => a.s - b.s);
  const ordered = [...tasks].sort((a, b) => (a.status === "done") - (b.status === "done"));
  let lastDay = "";

  return (
    <>
      <section>
        <h2>Appointments</h2>
        {upcoming.length === 0 && <p className="muted">No upcoming appointments.</p>}
        <ul>
          {upcoming.map((e) => {
            const label = dayLabel(e.s);
            const header = label !== lastDay;
            lastDay = label;
            return (
              <li key={e.id}>
                {header && <div className="day">{label}</div>}
                <div className="row">
                  <time>{hm(e.s)} to {hm(e.f)}</time>
                  <span>{e.title}</span>
                </div>
              </li>
            );
          })}
        </ul>
      </section>
      <section>
        <h2>To-dos</h2>
        {ordered.length === 0 && <p className="muted">Nothing on your list.</p>}
        <ul>
          {ordered.map((t) => (
            <li key={t.id} className="row">
              <time>{t.due ? `${dayLabel(new Date(t.due))}, ${hm(new Date(t.due))}` : "No due time"}</time>
              <span className={t.status === "done" ? "done" : ""}>{t.title}</span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

export default function App() {
  const v = useVoiceAgent();
  const [page, setPage] = useState("voice");
  const [draft, setDraft] = useState("");
  const live = v.phase !== "off" && v.phase !== "connecting";

  return (
    <div className="app">
      
      <header className="top">
        <div className="brand">
          <span className="brand__mark" />
          Voice Scheduler
        </div>

        <nav className="top-nav" aria-label="Main navigation">
          <button
            className={`nav-link ${page === "voice" ? "nav-link--active" : ""}`}
            onClick={() => setPage("voice")}
            aria-current={page === "voice" ? "page" : undefined}
          >
            Voice Agent
          </button>

          <button
            className={`nav-link ${page === "doctors" ? "nav-link--active" : ""}`}
            onClick={() => setPage("doctors")}
            aria-current={page === "doctors" ? "page" : undefined}
          >
            Doctors
          </button>
        </nav>

        <span className={`pill ${live ? "pill--on" : ""}`}>
          {live ? "Call live" : "Offline"}
        </span>
      </header>

    {page === "doctors" ? (
      <DoctorsPage />
    ) : (
      <main className="grid">
        <section className="stage">
          <Orb phase={v.phase} elRef={v.orbRef} />
          <h1 className="state" aria-live="polite">{v.muted && live ? "Mic muted" : LABEL[v.phase]}</h1>
          <p className="hint">{v.muted && live ? "Unmute to talk, or type a request." : HINT[v.phase]}</p>

          <div className="controls">
            {live ? (
              <>
                <button className="btn" aria-pressed={v.muted} onClick={v.toggleMute}>
                  <Icon name={v.muted ? "micOff" : "mic"} />{v.muted ? "Unmute" : "Mute"}
                </button>
                <button className="btn btn--end" onClick={v.end}><Icon name="close" />End call</button>
              </>
            ) : (
              <button className="btn btn--primary" onClick={v.start} disabled={v.phase === "connecting"}>
                <Icon name="mic" />{v.phase === "connecting" ? "Connecting" : "Start call"}
              </button>
            )}
          </div>
          {v.error && <p className="err" role="alert">{v.error}</p>}

          <details className="mic">
            <summary>Microphone sensitivity</summary>
            <input type="range" min="0.004" max="0.05" step="0.001" value={v.sensitivity}
              onChange={(e) => v.setSensitivity(Number(e.target.value))}
              aria-label="Microphone sensitivity" />
            <div className="mic__ends"><span>More sensitive</span><span>Less sensitive</span></div>
          </details>
        </section>

        <section className="convo">
          <div className="convo__head">Conversation</div>
          <Transcript messages={v.messages} partial={v.partial} live={live} onPick={v.sendText} />
          <form className="composer" onSubmit={(e) => { e.preventDefault(); v.sendText(draft); setDraft(""); }}>
            <input value={draft} onChange={(e) => setDraft(e.target.value)} disabled={!live}
              placeholder={live ? "Or type a request" : "Start the call to chat"}
              aria-label="Type a request" />
            <button className="btn btn--primary" disabled={!live || !draft.trim()} aria-label="Send">
              <Icon name="send" />
            </button>
          </form>
        </section>

        <aside className="plan"><Schedule refreshKey={v.lastReplyAt} /></aside>
        </main>
)}
    </div>
  );
}

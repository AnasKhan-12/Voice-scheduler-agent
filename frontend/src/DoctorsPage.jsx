import { useEffect, useState } from "react";
import ReminderBell from "./ReminderBell"; 
const toDate = (value) => new Date(value.replace(" ", "T"));

const formatTime = (date) =>
  date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

const formatDate = (date) =>
  date.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

const initials = (name) =>
  name
    .replace("Dr. ", "")
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2);

export default function DoctorsPage() {
  const [doctors, setDoctors] = useState([]);
  const [selectedDoctor, setSelectedDoctor] = useState("");
  const [events, setEvents] = useState([]);
  const [loadingDoctors, setLoadingDoctors] = useState(true);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;

    fetch("/api/doctors/")
      .then((response) => {
        if (!response.ok) throw new Error("Could not load doctors.");
        return response.json();
      })
      .then((data) => {
        if (!active) return;

        setDoctors(data.doctors);

        if (data.doctors.length) {
          setSelectedDoctor(data.doctors[0].id);
        }

        setLoadingDoctors(false);
      })
      .catch(() => {
        if (active) {
          setError("Unable to load doctors. Check your backend.");
          setLoadingDoctors(false);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!selectedDoctor) return;

    let active = true;

    async function loadAppointments() {
      setLoadingEvents(true);
      setError("");

      try {
        const response = await fetch(
          `/api/events/?doctor_id=${encodeURIComponent(selectedDoctor)}`
        );

        if (!response.ok) {
          throw new Error("Could not load appointments.");
        }

        const data = await response.json();

        if (active) {
          setEvents(
            data.events
              .map((event) => ({
                ...event,
                startDate: toDate(event.start),
                endDate: toDate(event.end),
              }))
              .sort((a, b) => a.startDate - b.startDate)
          );
        }
      } catch {
        if (active) {
          setError("Unable to load appointments. Please try again.");
        }
      } finally {
        if (active) setLoadingEvents(false);
      }
    }

    loadAppointments();

    const timer = setInterval(loadAppointments, 30000);

    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [selectedDoctor]);

  const doctor = doctors.find((item) => item.id === selectedDoctor);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const upcoming = events.filter((event) => event.endDate >= today);

  if (loadingDoctors) {
    return <section className="doctors-page">Loading doctors…</section>;
  }

  return (
    <main className="doctors-page">
      <div className="doctors-heading">
        <div>
          <p className="eyebrow">CLINIC WORKSPACE</p>
          <h1>Doctor appointments</h1>
          <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <ReminderBell key={selectedDoctor} doctorId={selectedDoctor} />
          </header>
          <p className="muted">
            Select a doctor to view their upcoming schedule.
          </p>
        </div>
        <div className="appointment-total">
          <span>{upcoming.length}</span>
          <span>appointments</span>
        </div>
      </div>

      <section className="doctor-grid" aria-label="Choose a doctor">
        {doctors.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`doctor-card ${
              selectedDoctor === item.id ? "doctor-card--active" : ""
            }`}
            onClick={() => setSelectedDoctor(item.id)}
            aria-pressed={selectedDoctor === item.id}
          >
            <span className="doctor-avatar">{initials(item.name)}</span>
            <span className="doctor-info">
              <strong>{item.name}</strong>
              <span>{item.specialty}</span>
            </span>
            <span className="doctor-indicator" aria-hidden="true">
              {selectedDoctor === item.id ? "✓" : ""}
            </span>
          </button>
        ))}
      </section>

      <section className="doctor-schedule">
        <div className="schedule-heading">
          <div>
            <p className="eyebrow">SCHEDULE</p>
            <h2>{doctor ? `${doctor.name}'s schedule` : "Appointments"}</h2>
          </div>
          <span className="schedule-count">
            {upcoming.length} upcoming
          </span>
        </div>

        {error && <p className="schedule-error">{error}</p>}

        {loadingEvents ? (
          <p className="muted schedule-empty">Loading appointments…</p>
        ) : !error && upcoming.length === 0 ? (
          <div className="schedule-empty">
            <span className="empty-calendar">□</span>
            <h3>No upcoming appointments</h3>
            <p className="muted">
              Appointments for this doctor will appear here.
            </p>
          </div>
        ) : (
          <div className="appointment-list">
            {upcoming.map((event) => (
              <article className="appointment-card" key={event.id}>
                <div className="appointment-date">
                  <span>{formatDate(event.startDate)}</span>
                  <strong>{formatTime(event.startDate)}</strong>
                  <span>to {formatTime(event.endDate)}</span>
                </div>

                
                <div className="appointment-details">
                    <h3>{event.patient_name}</h3>
                    <p>{event.title}</p>
                    <p>
                        {Math.max(
                        0,
                        Math.round(
                            (event.endDate - event.startDate) / 60000
                        )
                        )} minutes
                    </p>
                </div>

                <span className="appointment-mark" aria-hidden="true">
                  ✓
                </span>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

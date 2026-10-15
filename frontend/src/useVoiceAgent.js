import { useCallback, useEffect, useRef, useState } from "react";

// Same logic as your live-call HTML page, packaged as one React hook.
const MIC_RATE = 16000;
const TTS_RATE = 24000;
const SILENCE_LIMIT = 0.6; // seconds of quiet that end your turn
const MIN_VOICED = 0.25; // shorter sounds (clicks, coughs) are ignored
const PREROLL_FRAMES = 8; // audio kept from just before you started talking
const FLUSH_SAMPLES = 4096; // send mic audio roughly every 0.25 s

const WORKLET_CODE = `
class Capture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0][0];
    if (ch) this.port.postMessage(ch.slice());
    return true;
  }
}
registerProcessor("capture", Capture);
`;

function wsUrl() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws/voice/`;
}

function flushAudio(s) {
  if (s.pendingLen && s.ws?.readyState === WebSocket.OPEN) {
    const out = new Float32Array(s.pendingLen);
    let off = 0;
    for (const f of s.pending) {
      out.set(f, off);
      off += f.length;
    }
    s.ws.send(out.buffer);
  }
  s.pending = [];
  s.pendingLen = 0;
}

function appendAudio(s, frame) {
  s.pending.push(frame);
  s.pendingLen += frame.length;
  if (s.pendingLen >= FLUSH_SAMPLES) flushAudio(s);
}

function playChunk(s, arrayBuffer) {
  const ctx = s.playCtx;
  if (!ctx) return;
  if (ctx.state !== "running") ctx.resume();
  const samples = new Float32Array(arrayBuffer);
  const buf = ctx.createBuffer(1, samples.length, TTS_RATE);
  buf.copyToChannel(samples, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(s.analyser);
  const startAt = Math.max(ctx.currentTime, s.nextTime);
  src.start(startAt);
  s.nextTime = startAt + buf.duration;
}

export function useVoiceAgent() {
  // phase: off | connecting | listening | hearing | thinking | speaking
  const [phase, setPhase] = useState("off");
  const [messages, setMessages] = useState([]);
  const [partial, setPartial] = useState(""); // live words of what you are saying right now
  const [error, setError] = useState("");
  const [muted, setMuted] = useState(false);
  const [lastReplyAt, setLastReplyAt] = useState(0);
  const [sensitivity, setSensitivityState] = useState(
    () => Number(localStorage.getItem("vs-threshold")) || 0.015
  );

  const orbRef = useRef(null); // the orb element; its --level is animated directly
  const r = useRef({
    ws: null, stream: null, micCtx: null, source: null, worklet: null,
    playCtx: null, analyser: null, buf: null, nextTime: 0, raf: 0, timers: [],
    active: false, phase: "off", utterance: false, processing: false, muted: false,
    silence: 0, voiced: 0, preRoll: [], pending: [], pendingLen: 0,
    micLevel: 0, smooth: 0, msgId: 0,
    threshold: Number(localStorage.getItem("vs-threshold")) || 0.015,
  });

  const go = useCallback((p) => {
    r.current.phase = p;
    setPhase(p);
  }, []);

  const addMessage = useCallback((role, text) => {
    setMessages((m) => [...m, { id: r.current.msgId++, role, text }]);
  }, []);

  // Go back to listening, optionally after the agent's audio has finished playing.
  const release = useCallback((delayMs = 0) => {
    const done = () => {
      const s = r.current;
      if (!s.active) return;
      s.processing = false;
      setPartial("");
      go("listening");
    };
    if (delayMs > 0) r.current.timers.push(setTimeout(done, delayMs));
    else done();
  }, [go]);

  const onMessage = useCallback((e) => {
    const s = r.current;
    if (typeof e.data !== "string") return playChunk(s, e.data);
    const data = JSON.parse(e.data);

    if (data.type === "status") {
      if (data.text === "speaking...") go("speaking");
      else if (data.text === "done") release();
      else go("thinking");
    } else if (data.type === "partial") {
      if (s.phase === "hearing") setPartial(data.text); // ignore late captions
    } else if (data.type === "transcript") {
      setPartial("");
      if (data.text) addMessage("you", data.text);
      else release();
    } else if (data.type === "reply") {
      addMessage("agent", data.text);
      setLastReplyAt(Date.now());
    } else if (data.type === "error") {
      addMessage("error", data.text);
      release();
    } else if (data.type === "tts_start") {
      s.nextTime = 0;
      go("speaking");
    } else if (data.type === "tts_end") {
      // Wait for queued audio to finish so the mic doesn't hear the agent.
      const left = Math.max(0, s.nextTime - (s.playCtx?.currentTime ?? 0));
      release(left * 1000 + 250);
    }
  }, [go, addMessage, release]);

  const handleFrame = useCallback((frame) => {
    const s = r.current;
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length);
    s.micLevel = s.muted ? 0 : Math.min(1, rms * 8);
    if (s.processing || s.muted) return;

    const isSpeech = rms > s.threshold;

    if (!s.utterance && isSpeech) {
      if (s.ws?.readyState !== WebSocket.OPEN) return;
      s.utterance = true;
      s.silence = 0;
      s.voiced = 0;
      s.ws.send(JSON.stringify({ type: "start" }));
      for (const f of s.preRoll) appendAudio(s, f);
      s.preRoll = [];
      appendAudio(s, frame);
      go("hearing");
    } else if (s.utterance) {
      appendAudio(s, frame);
      const sec = frame.length / MIC_RATE;
      if (isSpeech) {
        s.silence = 0;
        s.voiced += sec;
      } else {
        s.silence += sec;
      }
      if (s.silence >= SILENCE_LIMIT) {
        s.utterance = false;
        s.preRoll = [];
        if (s.voiced < MIN_VOICED) {
          s.pending = [];
          s.pendingLen = 0;
          if (s.ws?.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify({ type: "cancel" }));
          setPartial("");
          go("listening");
        } else {
          flushAudio(s);
          s.ws.send(JSON.stringify({ type: "stop" }));
          s.processing = true;
          go("thinking");
        }
      }
      return;
    }

    s.preRoll.push(frame);
    if (s.preRoll.length > PREROLL_FRAMES) s.preRoll.shift();
  }, [go]);

  const cleanup = useCallback(() => {
    const s = r.current;
    s.active = false;
    cancelAnimationFrame(s.raf);
    s.timers.forEach(clearTimeout);
    s.timers = [];
    if (s.ws) {
      s.ws.onclose = null;
      s.ws.onmessage = null;
      s.ws.close();
      s.ws = null;
    }
    s.stream?.getTracks().forEach((t) => t.stop());
    s.worklet?.disconnect();
    s.source?.disconnect();
    if (s.micCtx && s.micCtx.state !== "closed") s.micCtx.close();
    if (s.playCtx && s.playCtx.state !== "closed") s.playCtx.close();
    Object.assign(s, {
      stream: null, worklet: null, source: null, micCtx: null, playCtx: null,
      analyser: null, utterance: false, processing: false, pending: [],
      pendingLen: 0, preRoll: [], silence: 0, voiced: 0, micLevel: 0, smooth: 0,
    });
    orbRef.current?.style.setProperty("--level", "0");
    setPartial("");
  }, []);

  const start = useCallback(async () => {
    const s = r.current;
    if (s.active) return;
    s.active = true;
    setError("");
    go("connecting");
    try {
      // Created inside the click, so the browser allows audio playback.
      s.playCtx = new AudioContext({ sampleRate: TTS_RATE });
      await s.playCtx.resume();
      s.analyser = s.playCtx.createAnalyser();
      s.analyser.connect(s.playCtx.destination);
      s.buf = new Float32Array(s.analyser.fftSize);

      s.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      s.micCtx = new AudioContext({ sampleRate: MIC_RATE });
      await s.micCtx.resume();
      if (s.micCtx.sampleRate !== MIC_RATE) {
        throw new Error(`Expected 16000 Hz audio but got ${s.micCtx.sampleRate} Hz. Use Chrome or Edge.`);
      }
      const url = URL.createObjectURL(new Blob([WORKLET_CODE], { type: "application/javascript" }));
      await s.micCtx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);

      s.source = s.micCtx.createMediaStreamSource(s.stream);
      s.worklet = new AudioWorkletNode(s.micCtx, "capture");
      s.worklet.port.onmessage = (ev) => handleFrame(ev.data);
      const silent = s.micCtx.createGain();
      silent.gain.value = 0;
      s.source.connect(s.worklet);
      s.worklet.connect(silent);
      silent.connect(s.micCtx.destination);

      await new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl());
        ws.binaryType = "arraybuffer";
        s.ws = ws;
        ws.onopen = resolve;
        ws.onerror = () => reject(new Error("Could not reach the server. Is Django running?"));
        ws.onmessage = onMessage;
        ws.onclose = () => {
          if (!s.active) return;
          cleanup();
          go("off");
          setError("Connection lost. Start the call again.");
        };
      });

      const tick = () => {
        if (!s.active) return;
        let v = s.micLevel;
        if (s.phase === "speaking" && s.analyser) {
          s.analyser.getFloatTimeDomainData(s.buf);
          let sum = 0;
          for (let i = 0; i < s.buf.length; i++) sum += s.buf[i] * s.buf[i];
          v = Math.min(1, Math.sqrt(sum / s.buf.length) * 5);
        } else if (s.phase !== "listening" && s.phase !== "hearing") {
          v = 0;
        }
        s.smooth += (v - s.smooth) * 0.25;
        orbRef.current?.style.setProperty("--level", s.smooth.toFixed(3));
        s.raf = requestAnimationFrame(tick);
      };
      s.raf = requestAnimationFrame(tick);
      go("listening");
    } catch (err) {
      const msg =
        err.name === "NotAllowedError" ? "Microphone access is blocked. Allow it in the address bar, then try again."
        : err.name === "NotFoundError" ? "No microphone found. Plug one in or choose another input in Windows settings."
        : err.message;
      cleanup();
      go("off");
      setError(msg);
    }
  }, [go, handleFrame, onMessage, cleanup]);

  const end = useCallback(() => {
    cleanup();
    go("off");
    setMuted(false);
    r.current.muted = false;
  }, [cleanup, go]);

  const sendText = useCallback((text) => {
    const s = r.current;
    const t = text.trim();
    if (!t) return;
    if (s.ws?.readyState !== WebSocket.OPEN) {
      setError("Start the call to send messages.");
      return;
    }
    addMessage("you", t);
    s.ws.send(JSON.stringify({ type: "text", text: t }));
    s.processing = true;
    go("thinking");
  }, [addMessage, go]);

  const toggleMute = useCallback(() => {
    const s = r.current;
    s.muted = !s.muted;
    setMuted(s.muted);
    if (s.muted && s.utterance) {
      // Drop a half-finished utterance instead of sending it.
      s.utterance = false;
      s.pending = [];
      s.pendingLen = 0;
      if (s.ws?.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify({ type: "cancel" }));
      setPartial("");
      go("listening");
    }
  }, [go]);

  const setSensitivity = useCallback((v) => {
    r.current.threshold = v;
    setSensitivityState(v);
    localStorage.setItem("vs-threshold", String(v));
  }, []);

  useEffect(() => cleanup, [cleanup]);

  return {
    phase, messages, partial, error, muted, sensitivity, lastReplyAt, orbRef,
    start, end, sendText, toggleMute, setSensitivity,
  };
}

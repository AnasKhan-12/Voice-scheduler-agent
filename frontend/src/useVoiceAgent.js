import { useCallback, useEffect, useRef, useState } from "react";

// Same logic as your live-call HTML page, packaged as one React hook.
const MIC_RATE = 16000;
const TTS_RATE = 24000;
const SILENCE_LIMIT = 0.6; // seconds of quiet that end your turn
const MIN_VOICED = 0.25; // shorter sounds (clicks, coughs) are ignored
const PREROLL_FRAMES = 8; // audio kept from just before you started talking
const FLUSH_SAMPLES = 4096; // send mic audio roughly every 0.25 s

// Barge-in (interrupting the agent while it speaks).
// Normally the SERVER's Silero VAD decides: we stream mic audio to it while the agent talks and it replies "barge_in".
// BARGE_FACTOR / BARGE_MIN_VOICED are only the fallback, used when the server has no VAD model.
const BARGE_FACTOR = 1.5;
const BARGE_MIN_VOICED = 0.2;
const BARGE_PREROLL_FRAMES = 125; // ~1 s of mic audio kept so the start of your sentence isn't lost
const PROBE_SAMPLES = 1024; // mic audio sent to the server VAD in ~64 ms pieces

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

// Send mic audio to the server's VAD (only while the agent is speaking).
function sendProbe(s, frame) {
  s.probe.push(frame);
  s.probeLen += frame.length;
  if (s.probeLen < PROBE_SAMPLES) return;
  if (s.ws?.readyState === WebSocket.OPEN) {
    const out = new Float32Array(s.probeLen);
    let off = 0;
    for (const f of s.probe) {
      out.set(f, off);
      off += f.length;
    }
    const bytes = new Uint8Array(out.buffer);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    s.ws.send(JSON.stringify({ type: "probe", pcm: btoa(bin) }));
  }
  s.probe = [];
  s.probeLen = 0;
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
  src.connect(s.outGain || s.analyser);
  s.sources.push(src);
  src.onended = () => {
    s.sources = s.sources.filter((x) => x !== src);
  };
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
    outGain: null, sources: [], interrupted: false, bargeVoiced: 0,
    serverVad: false, probe: [], probeLen: 0,
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
      s.bargeVoiced = 0;
      s.probe = [];
      s.probeLen = 0;
      setPartial("");
      go("listening");
    };
    if (delayMs > 0) r.current.timers.push(setTimeout(done, delayMs));
    else done();
  }, [go]);

  // Silence the agent immediately and tell the server to stop generating audio.
  const stopAgentAudio = useCallback(() => {
    const s = r.current;
    s.interrupted = true; // ignore any audio still in flight
    s.timers.forEach(clearTimeout); // cancel the pending release() scheduled by tts_end
    s.timers = [];
    // Everything the agent says is routed through one gain node: cutting it silences all queued audio at once.
    if (s.playCtx && s.analyser) {
      try { s.outGain?.disconnect(); } catch { /* already disconnected */ }
      s.outGain = s.playCtx.createGain();
      s.outGain.connect(s.analyser);
    }
    for (const src of s.sources) {
      try { src.onended = null; src.stop(); src.disconnect(); } catch { /* already stopped */ }
    }
    s.sources = [];
    s.nextTime = 0;
    s.probe = [];
    s.probeLen = 0;
    if (s.ws?.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify({ type: "interrupt" }));
  }, []);

  const onMessage = useCallback((e) => {
    const s = r.current;
    if (typeof e.data !== "string") {
      if (s.interrupted) return; // drop audio still arriving after an interruption
      return playChunk(s, e.data);
    }
    const data = JSON.parse(e.data);

    if (data.type === "status") {
      if (data.text === "speaking...") go("speaking");
      else if (data.text === "done") release();
      else go("thinking");
    } else if (data.type === "vad") {
      s.serverVad = !!data.ready; // the server has a Silero VAD model, so it decides on interruptions
    } else if (data.type === "barge_in") {
      // The server's VAD heard the user talking over the agent: stop the agent and start recording.
      if (s.phase !== "speaking" || s.utterance || s.muted) return;
      if (s.ws?.readyState !== WebSocket.OPEN) return;
      stopAgentAudio();
      s.processing = false;
      s.utterance = true;
      s.silence = 0;
      s.voiced = 0;
      s.ws.send(JSON.stringify({ type: "start" }));
      for (const f of s.preRoll) appendAudio(s, f);
      s.preRoll = [];
      go("hearing");
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
      s.interrupted = false; // a new reply is starting, allow audio again
      s.nextTime = 0;
      go("speaking");
    } else if (data.type === "tts_end") {
      if (s.interrupted) return;
      // Wait for queued audio to finish so the mic doesn't hear the agent.
      const left = Math.max(0, s.nextTime - (s.playCtx?.currentTime ?? 0));
      release(left * 1000 + 250);
    }
  }, [go, addMessage, release, stopAgentAudio]);

  const handleFrame = useCallback((frame) => {
    const s = r.current;
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length);
    s.micLevel = s.muted ? 0 : Math.min(1, rms * 8);
    if (s.muted) return;

    const speaking = s.phase === "speaking";
    // While thinking the mic is still ignored; while the agent speaks we listen for an interruption.
    if (s.processing && !speaking) return;

    const sec = frame.length / MIC_RATE;

    if (speaking && !s.utterance) {
      s.preRoll.push(frame);
      if (s.preRoll.length > BARGE_PREROLL_FRAMES) s.preRoll.shift();

      if (s.serverVad) {
        sendProbe(s, frame); // the server's Silero VAD decides and answers with "barge_in"
        return;
      }

      // Fallback (server has no VAD model): simple loudness check with a leaky counter.
      const loud = rms > s.threshold * BARGE_FACTOR;
      s.bargeVoiced = loud ? s.bargeVoiced + sec : Math.max(0, s.bargeVoiced - sec * 0.5);
      if (s.bargeVoiced < BARGE_MIN_VOICED) return;
      // Interruption confirmed: stop the agent, then fall through and start a normal utterance.
      s.preRoll.pop(); // the current frame is appended again by the utterance-start code below
      s.bargeVoiced = 0;
      stopAgentAudio();
      s.processing = false;
      go("listening");
    }

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
  }, [go, stopAgentAudio]);

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
      analyser: null, outGain: null, sources: [], interrupted: false, bargeVoiced: 0, serverVad: false, probe: [], probeLen: 0, utterance: false, processing: false, pending: [],
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
      s.outGain = s.playCtx.createGain();
      s.outGain.connect(s.analyser);
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
    setMessages([]); // clear the conversation shown on screen
    r.current.msgId = 0;
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
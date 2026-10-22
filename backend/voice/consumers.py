import asyncio
import base64
import json
import threading
import time

import numpy as np
from channels.generic.websocket import AsyncWebsocketConsumer

from . import stt, tts, vad
from .llm import Agent

SLICE_SAMPLES = 24000 * 2  # 2 seconds of audio per message

def _warm_up():
    try:
        stt.get_model()
        for _ in tts.synthesize("Ready."):
            pass
        print("Models warmed up and ready.")
    except Exception as exc:
        print("Warm-up failed:", exc)


threading.Thread(target=_warm_up, daemon=True).start()

# Interruption detection (Silero VAD runs here on the server)
VAD_THRESHOLD = 0.6        # speech probability above this counts as "the user is talking"
BARGE_MIN_SECONDS = 0.4    # this much (leaky) speech while the agent talks = an interruption
VAD_FRAME_SECONDS = vad.FRAME / vad.SAMPLE_RATE

PARTIAL_EVERY = 0.8  # seconds between live-caption updates
MIN_NEW_SAMPLES = 8000  # need at least 0.5 s of new audio before re-transcribing


class VoiceConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        self.chunks = []
        self.agent = None
        self.partial_task = None
        self.partial_stop = None
        self.reply_task = None  # the running "think + speak" task, so it can be cancelled on interrupt
        self.vad = None
        self.vad_active = False  # True while the agent is speaking and we are watching for an interruption
        self.barge_speech = 0.0
        try:
            self.vad = vad.SileroVAD()
        except Exception as exc:
            print("Silero VAD unavailable, the browser will detect interruptions itself:", exc)
        await self.accept()
        await self.send_json({"type": "vad", "ready": self.vad is not None})

    async def disconnect(self, code):
        await self._cancel_reply()
        await self._stop_partials()

    async def _cancel_reply(self):
        task, self.reply_task = self.reply_task, None
        if task and not task.done():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass

    async def _handle_probe(self, pcm_b64):
        """Mic audio sent by the browser while the agent speaks. Silero decides if the user is talking."""
        if self.vad is None or not self.vad_active:
            return
        audio = np.frombuffer(base64.b64decode(pcm_b64), dtype=np.float32)
        for p in self.vad.feed(audio):
            if p >= VAD_THRESHOLD:
                self.barge_speech += VAD_FRAME_SECONDS
            else:  # short gaps between words only slow the counter down
                self.barge_speech = max(0.0, self.barge_speech - VAD_FRAME_SECONDS * 0.5)
        if self.barge_speech >= BARGE_MIN_SECONDS:
            self.vad_active = False
            self.barge_speech = 0.0
            await self._cancel_reply()
            await self.send_json({"type": "barge_in"})

    # ---- live captions: re-transcribe the audio so far while the user is still talking ----
    def _start_partials(self):
        self.partial_stop = asyncio.Event()
        self.partial_task = asyncio.create_task(self._partial_loop(self.partial_stop))

    async def _stop_partials(self):
        task, stop = self.partial_task, self.partial_stop
        self.partial_task = self.partial_stop = None
        if task:
            stop.set()
            await task  # waits for at most one in-flight partial, so Whisper is never used twice at once

    async def _partial_loop(self, stop):
        done, last = 0, ""
        while True:
            try:
                await asyncio.wait_for(stop.wait(), PARTIAL_EVERY)
                return  # stop was requested
            except asyncio.TimeoutError:
                pass
            total = sum(len(c) for c in self.chunks)
            if total - done < MIN_NEW_SAMPLES:
                continue
            audio = np.concatenate(self.chunks)
            done = len(audio)
            try:
                text = await asyncio.to_thread(stt.transcribe_partial, audio)
            except Exception as exc:
                print("Partial transcription failed:", exc)
                continue
            if stop.is_set():
                return
            if text and text != last:
                last = text
                await self.send_json({"type": "partial", "text": text})

    async def receive(self, text_data=None, bytes_data=None):
        if bytes_data:
            self.chunks.append(np.frombuffer(bytes_data, dtype=np.float32))
            return

        data = json.loads(text_data)
        kind = data.get("type")

        if kind == "text":
            text = data.get("text", "").strip()
            if text:
                await self.handle_user_text(text, speak=False)

        elif kind == "probe":
            await self._handle_probe(data.get("pcm", ""))

        elif kind == "interrupt":  # the user started talking while the agent was speaking
            self.vad_active = False
            await self._cancel_reply()

        elif kind == "start":
            self.vad_active = False
            await self._cancel_reply()  # safety: a new utterance always stops any reply in progress
            await self._stop_partials()
            self.chunks = []
            self._start_partials()

        elif kind == "cancel":  # the browser dropped a cough / muted mid-sentence
            await self._stop_partials()
            self.chunks = []

        elif kind == "stop":
            await self._stop_partials()
            if not self.chunks:
                await self.send_json({"type": "transcript", "text": ""})
                return
            audio = np.concatenate(self.chunks)
            self.chunks = []
            await self.send_json({"type": "status", "text": "transcribing..."})
            t0 = time.perf_counter()
            text = await asyncio.to_thread(stt.transcribe, audio)
            print(f"TIMING stt: {time.perf_counter() - t0:.1f}s for {len(audio) / 16000:.1f}s of audio")
            await self.send_json({"type": "transcript", "text": text})
            if text:
                # Run as a task so receive() stays free to handle an "interrupt" while the agent speaks.
                self.reply_task = asyncio.create_task(self.handle_user_text(text, speak=True))

    async def handle_user_text(self, text, speak):
        await self.send_json({"type": "status", "text": "thinking..."})
        try:
            if self.agent is None:
                self.agent = Agent()
            t0 = time.perf_counter()
            reply = await asyncio.to_thread(self.agent.reply, text)
            print(f"TIMING llm: {time.perf_counter() - t0:.1f}s")
        except Exception as exc:
            await self.send_json({"type": "error", "text": str(exc)})
            return
        await self.send_json({"type": "reply", "text": reply})
        if speak:
            await self.speak(reply)
        else:
            await self.send_json({"type": "status", "text": "done"})

    async def speak(self, text):
        if self.vad is not None:  # start watching for an interruption with a clean VAD state
            self.vad.reset()
            self.barge_speech = 0.0
            self.vad_active = True
        await self.send_json({"type": "status", "text": "speaking..."})
        await self.send_json({"type": "tts_start"})
        t0 = time.perf_counter()
        audio_sec = 0.0
        first = True
        gen = tts.synthesize(text)
        try:
            while True:
                chunk = await asyncio.to_thread(next, gen, None)
                if chunk is None:
                    break
                if first:
                    print(f"TIMING tts: first audio after {time.perf_counter() - t0:.1f}s")
                    first = False
                audio_sec += len(chunk) / 24000
                for i in range(0, len(chunk), SLICE_SAMPLES):
                    await self.send(bytes_data=chunk[i:i + SLICE_SAMPLES].tobytes())
        finally:
            try:
                gen.close()
            except ValueError:  # a worker thread is still inside next(); it ends after the current sentence
                pass
        print(f"TIMING tts: {audio_sec:.1f}s of speech made in {time.perf_counter() - t0:.1f}s")
        await self.send_json({"type": "tts_end"})

    async def send_json(self, obj):
        await self.send(text_data=json.dumps(obj))
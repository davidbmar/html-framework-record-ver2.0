// web/record-ver2.0/js/recorder-box.js
// PCM recorder (no MediaRecorder). Captures Float32 PCM via ScriptProcessorNode,
// chunks by time, stores in IndexedDB, and emits UI events.
// Events: 'status' {status}, 'meter' {rms,peak}, 'chunk' {size,index}, 'stats' {durationMs,chunkCount,bytes}

export async function createRecorderBox({
  storage,
  chunkSeconds = 2,
  channels = 1 // we downmix to mono for storage/playback simplicity
} = {}) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('getUserMedia not supported');

  /* ------------ tiny event bus ------------ */
  const listeners = new Map();
  const on  = (ev, fn) => { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev).add(fn); };
  const off = (ev, fn) => listeners.get(ev)?.delete(fn);
  const emit = (ev, payload) => (listeners.get(ev) || []).forEach(fn => fn(payload));

  /* ------------ session state ------------ */
  let status = 'idle';
  let currentId = null;
  let chunkIndex = 0;
  let startTs = 0;        // wall clock start
  let pausedAccum = 0;
  let pauseTs = 0;
  let stats = { durationMs: 0, chunkCount: 0, bytes: 0 };
  let statsTimer = 0;

  /* ------------ audio graph ------------ */
  let stream = null;
  let ctx = null;
  let src = null;
  let analyser = null;
  let proc = null;
  let meterRAF = 0;

  /* ------------ PCM accumulation ------------ */
  let sampleRate = 48000;
  let sliceFramesTarget = 48000 * Math.max(0.25, Number(chunkSeconds) || 2); // min 250ms slice
  sliceFramesTarget = Math.round(sliceFramesTarget / 128) * 128; // align to 128 frames
  let accum = new Float32Array(0); // mono accumulation buffer
  let isPaused = false;

  function setStatus(s) { status = s; emit('status', { status: s }); }

  /* ------------ stats + meter ------------ */
  function startStats() {
    statsTimer = setInterval(() => {
      if (status === 'recording') {
        stats.durationMs = Date.now() - startTs - pausedAccum;
        emit('stats', { ...stats });
      }
    }, 250);
  }
  function stopStats() { if (statsTimer) clearInterval(statsTimer); statsTimer = 0; }

  function startMeter() {
    if (!analyser) return;
    const buf = new Float32Array(analyser.fftSize || 2048);
    const tick = () => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0, peak = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = buf[i];
        sum += v*v;
        if (Math.abs(v) > peak) peak = Math.abs(v);
      }
      const rms = Math.sqrt(sum / buf.length);
      emit('meter', { rms, peak });
      meterRAF = requestAnimationFrame(tick);
    };
    meterRAF = requestAnimationFrame(tick);
  }
  function stopMeter() { if (meterRAF) cancelAnimationFrame(meterRAF); meterRAF = 0; }

  /* ------------ accumulation helpers ------------ */
  function appendToAccum(monoChunk) {
    const out = new Float32Array(accum.length + monoChunk.length);
    out.set(accum, 0);
    out.set(monoChunk, accum.length);
    accum = out;
  }

  async function flushFullSlices() {
    while (accum.length >= sliceFramesTarget) {
      const slice = accum.subarray(0, sliceFramesTarget);
      const copy  = new Float32Array(slice.length);
      copy.set(slice);

      // shift remainder
      const remain = new Float32Array(accum.length - sliceFramesTarget);
      remain.set(accum.subarray(sliceFramesTarget));
      accum = remain;

      const blob = new Blob([copy.buffer], { type: 'application/octet-stream' });
      const startMs = framesToMs((chunkIndex) * sliceFramesTarget, sampleRate);
      const endMs   = framesToMs((chunkIndex + 1) * sliceFramesTarget, sampleRate);

      await storage.putChunk({
        recordingId: currentId,
        index: chunkIndex++,
        blob,
        size: blob.size,
        startMs,
        endMs
      });
      stats.chunkCount += 1; stats.bytes += blob.size;
      emit('chunk', { size: blob.size, index: chunkIndex - 1 });
    }
  }

  async function flushRemainderOnStop() {
    if (accum.length === 0) return;
    const copy = new Float32Array(accum.length);
    copy.set(accum);
    accum = new Float32Array(0);

    const blob = new Blob([copy.buffer], { type: 'application/octet-stream' });
    const startMs = framesToMs((chunkIndex) * sliceFramesTarget, sampleRate);
    const endMs   = startMs + framesToMs(copy.length, sampleRate);

    await storage.putChunk({
      recordingId: currentId,
      index: chunkIndex++,
      blob,
      size: blob.size,
      startMs,
      endMs
    });
    stats.chunkCount += 1; stats.bytes += blob.size;
    emit('chunk', { size: blob.size, index: chunkIndex - 1 });
  }

  /* ------------ lifecycle ------------ */
  async function beginSession() {
    currentId = cryptoRandomId();
    startTs = Date.now();
    pausedAccum = 0;
    chunkIndex = 0;
    stats = { durationMs: 0, chunkCount: 0, bytes: 0 };
    accum = new Float32Array(0);
    isPaused = false;

    await storage.putRecording({
      id: currentId,
      createdAt: startTs,
      updatedAt: startTs,
      mimeType: 'audio/pcm;format=f32',
      status: 'recording',
      durationMs: 0
    });

    await storage.setManifest(currentId, {
      recordingId: currentId,
      format: 'pcm-f32',
      channels: 1,
      sampleRate,
      chunkSeconds: Number(chunkSeconds)
    });

    setStatus('recording');
    startStats();
    startMeter();
  }

  async function finalizeSession() {
    const effectiveDuration = Date.now() - startTs - pausedAccum;
    await storage.setDuration(currentId, effectiveDuration);
    await storage.markStatus(currentId, 'ready');
    setStatus('ready');
    currentId = null;
  }

  function teardown() {
    try { proc?.disconnect(); } catch {}
    try { src?.disconnect(); } catch {}
    try { stream?.getTracks?.().forEach(t => t.stop()); } catch {}
    try { ctx?.close(); } catch {}
    stream = null; ctx = null; src = null; analyser = null; proc = null;
    stopMeter(); stopStats();
  }

  /* ------------ public API ------------ */
  async function start() {
    if (status === 'recording' || status === 'paused') return;

    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: { ideal: Math.max(1, channels) },
        sampleRate:   { ideal: 48000 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl:  false
      }
    });

    ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    sampleRate = ctx.sampleRate;
    sliceFramesTarget = Math.round(((Number(chunkSeconds) || 2) * sampleRate) / 128) * 128;

    src = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser(); analyser.fftSize = 2048; src.connect(analyser);

    // ScriptProcessorNode (deprecated but works everywhere in Chrome)
    const bufferSize = 4096; // can try 2048 if you want lower latency
    const inChannels = Math.min(2, src.channelCount || 2);
    proc = ctx.createScriptProcessor(bufferSize, inChannels, 1);
    src.connect(proc);
    proc.connect(ctx.destination); // keep node alive; audio not audible

    proc.onaudioprocess = async (e) => {
      if (status !== 'recording' || isPaused) return;
      const ch0 = e.inputBuffer.getChannelData(0);
      const ch1 = inChannels > 1 ? e.inputBuffer.getChannelData(1) : ch0;

      // downmix to mono
      const mono = new Float32Array(ch0.length);
      for (let i = 0; i < ch0.length; i++) mono[i] = (ch0[i] + ch1[i]) * 0.5;

      appendToAccum(mono);
      // avoid blocking audio thread too long
      // schedule the flush on microtask to let UI breathe
      Promise.resolve().then(flushFullSlices).catch(console.error);
    };

    await beginSession();
  }

  async function pause() {
    if (status !== 'recording') return;
    isPaused = true;
    pauseTs = Date.now();
    setStatus('paused');
  }

  async function resume() {
    if (status !== 'paused') return;
    if (pauseTs) pausedAccum += (Date.now() - pauseTs);
    pauseTs = 0;
    isPaused = false;
    setStatus('recording');
  }

  async function stop() {
    if (status !== 'recording' && status !== 'paused') return;
    // ensure we capture any remainder
    await flushRemainderOnStop().catch(console.error);
    await finalizeSession();
    teardown();
    setStatus('idle');
  }

  return { on, off, start, pause, resume, stop };
}

/* ------------ utils ------------ */
function framesToMs(frames, sampleRate) {
  return (frames / sampleRate) * 1000;
}
function cryptoRandomId() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  const b = new Uint8Array(16); crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2,'0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}


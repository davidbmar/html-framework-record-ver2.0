// Minimal recorder "box": handles mic capture, chunked MediaRecorder,
// local metering, and writing chunks to storage. Emits events via .on()

export async function createRecorderBox({ storage, chunkSeconds = 2, mimeType = 'audio/webm;codecs=opus' } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('getUserMedia not supported in this browser.');
  }

  // pick a supported mime
  const pickMime = (() => {
    const candidates = [mimeType, 'audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
    for (const m of candidates) {
      try {
        if (m && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m;
      } catch {}
    }
    return undefined; // let browser choose
  })();

  const listeners = new Map(); // event -> Set<fn>
  const emit = (ev, payload) => { (listeners.get(ev) || []).forEach(fn => fn(payload)); };
  const on = (ev, fn) => { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev).add(fn); };
  const off = (ev, fn) => { listeners.get(ev)?.delete(fn); };

  let mediaStream = null;
  let mediaRecorder = null;
  let audioCtx = null;
  let analyser = null;
  let meterRAF = 0;

  let status = 'idle';
  let currentId = null;
  let chunkIndex = 0;
  let startTs = 0;
  let pausedAccum = 0;
  let pauseTs = 0;
  let stats = { durationMs: 0, chunkCount: 0, bytes: 0 };
  let statsTimer = 0;

  function setStatus(s) {
    status = s;
    emit('status', { status: s });
  }

  async function start() {
    if (status === 'recording' || status === 'paused') return;

    const ms = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: { ideal: 1 },
        sampleRate: { ideal: 48000 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });
    mediaStream = ms;

    // Metering
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const srcNode = audioCtx.createMediaStreamSource(ms);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    srcNode.connect(analyser);

    // Create recording entry
    currentId = cryptoRandomId();
    chunkIndex = 0;
    pausedAccum = 0;
    stats = { durationMs: 0, chunkCount: 0, bytes: 0 };
    startTs = Date.now();

    await storage.putRecording({
      id: currentId,
      createdAt: startTs,
      updatedAt: startTs,
      mimeType: pickMime || 'audio/webm',
      status: 'recording',
      durationMs: 0
    });

    await storage.setManifest(currentId, {
      recordingId: currentId,
      chunkSeconds,
      codec: pickMime || 'browser-default'
    });

    // MediaRecorder
    const opts = {};
    if (pickMime) opts.mimeType = pickMime;
    mediaRecorder = new MediaRecorder(ms, opts);

    mediaRecorder.ondataavailable = async (e) => {
      if (!e.data || !e.data.size) return;
      const blob = e.data;
      await storage.putChunk({ recordingId: currentId, index: chunkIndex++, blob, size: blob.size });
      stats.chunkCount += 1;
      stats.bytes += blob.size;
      emit('chunk', { size: blob.size, index: chunkIndex - 1 });
    };

    mediaRecorder.onstop = async () => {
      // finalize duration
      const effectiveDuration = Date.now() - startTs - pausedAccum;
      await storage.setDuration(currentId, effectiveDuration);
      await storage.markStatus(currentId, 'ready');

      // teardown
      stopMeter();
      stopStats();
      teardownStream();

      setStatus('ready');
      currentId = null;
    };

    mediaRecorder.onerror = (e) => console.error('[MediaRecorder]', e.error || e);

    // Start with a timeslice so we actually get periodic chunks
    mediaRecorder.start(Math.max(250, Math.floor(Number(chunkSeconds) * 1000)));

    // Start meters + stats
    startMeter();
    startStats();

    setStatus('recording');
  }

  async function pause() {
    if (!mediaRecorder || status !== 'recording') return;
    mediaRecorder.pause();
    pauseTs = Date.now();
    setStatus('paused');
  }

  async function resume() {
    if (!mediaRecorder || status !== 'paused') return;
    mediaRecorder.resume();
    if (pauseTs) pausedAccum += (Date.now() - pauseTs);
    pauseTs = 0;
    setStatus('recording');
  }

  async function stop() {
    if (!mediaRecorder || (status !== 'recording' && status !== 'paused')) return;
    try { mediaRecorder.stop(); } catch {}
    if (pauseTs) pausedAccum += (Date.now() - pauseTs);
    setStatus('idle');
  }

  /* ---------------- meter & stats ---------------- */
  function startMeter() {
    const buf = new Float32Array(analyser.fftSize);
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
  function stopMeter() {
    if (meterRAF) cancelAnimationFrame(meterRAF);
    meterRAF = 0;
  }
  function startStats() {
    statsTimer = setInterval(() => {
      if (status === 'recording') {
        stats.durationMs = Date.now() - startTs - pausedAccum;
        emit('stats', { ...stats });
      }
    }, 250);
  }
  function stopStats() {
    if (statsTimer) clearInterval(statsTimer);
    statsTimer = 0;
  }

  function teardownStream() {
    try { mediaRecorder?.stream?.getTracks?.().forEach(t => t.stop()); } catch {}
    try { mediaRecorder = null; } catch {}
    try { audioCtx?.close(); } catch {}
    audioCtx = null;
    analyser = null;
    mediaStream = null;
  }

  return {
    on, off,
    start, pause, resume, stop
  };
}

function cryptoRandomId() {
  // UUID-ish
  if (crypto?.randomUUID) return crypto.randomUUID();
  const b = new Uint8Array(16); crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2,'0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}


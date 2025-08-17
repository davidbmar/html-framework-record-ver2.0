// UI harness: instant state updates + big state chip + list & playback
import { Player } from './player-mse.js';

export function initHarnessUI({ recorder, storage }) {
  const $ = (id) => document.getElementById(id);

  // Controls
  const btnStart   = $('btnStart');
  const btnPause   = $('btnPause');
  const btnResume  = $('btnResume');
  const btnStop    = $('btnStop');
  const btnRefresh = $('btnRefresh');
  const playerMode = $('playerMode');

  // State chip
  const stateChip  = $('stateChip');
  let   stateIcon  = $('stateIcon'); // replaced via outerHTML
  const stateLabel = $('stateLabel');

  // Meters / session
  const liveLevelBar    = $('liveLevelBar');
  const liveLevelText   = $('liveLevelText');
  const sessionStatus   = $('sessionStatus');
  const sessionChunks   = $('sessionChunks');
  const sessionDuration = $('sessionDuration');
  const sessionSize     = $('sessionSize');

  // List
  const recordingsList = $('recordingsList');
  const player = Player({ storage });

  // Counters for the current live session
  let bytes = 0, chunks = 0;

  const fmtTime = (ms) => {
    const sec = Math.floor(ms / 1000);
    const m = Math.floor(sec / 60), s = sec % 60;
    return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  };
  const fmtBytes = (n) => n < 1024 ? `${n} B` : (n < 1048576 ? `${(n/1024).toFixed(1)} KB` : `${(n/1048576).toFixed(2)} MB`);

  /* ---- Button styling helpers ---- */
  const VARIANT_ACTIVE = {
    start:  'text-white bg-emerald-600 hover:bg-emerald-700',
    pause:  'text-white bg-amber-600  hover:bg-amber-700',
    resume: 'text-white bg-indigo-600  hover:bg-indigo-700',
    stop:   'text-white bg-rose-600    hover:bg-rose-700',
  };
  function styleButton(btn, enabled) {
    const base = 'ctrl-btn';
    btn.className = base + (enabled ? '' : ' ctrl-disabled');
    if (enabled) {
      const v = btn.dataset.variant;
      if (VARIANT_ACTIVE[v]) btn.className += ' ' + VARIANT_ACTIVE[v];
    }
    btn.disabled = !enabled;
  }
  function setButtons({ start, pause, resume, stop }) {
    styleButton(btnStart,  !!start);
    styleButton(btnPause,  !!pause);
    styleButton(btnResume, !!resume);
    styleButton(btnStop,   !!stop);
  }

  /* ---- State chip (icon + label) ---- */
  function setStateChip(status) {
    // container color
    stateChip.className = 'flex items-center gap-2 px-3 py-1.5 rounded-full border ' +
      (status === 'recording'   ? 'bg-red-100    border-red-200    text-red-700'   :
       status === 'paused'      ? 'bg-amber-100  border-amber-200  text-amber-700' :
       status === 'requesting'  ? 'bg-sky-100    border-sky-200    text-sky-700'   :
                                  'bg-slate-100  border-slate-200  text-slate-700');

    // icons (currentColor)
    const ICONS = {
      recording:
        '<span class="inline-flex items-center gap-1">' +
          '<span class="inline-block w-2 h-2 rounded-full bg-red-600 pulse-dot"></span>' +
          '<svg class="w-5 h-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
            '<path d="M12 3a4 4 0 00-4 4v5a4 4 0 008 0V7a4 4 0 00-4-4zm-7 9a7 7 0 0014 0h-2a5 5 0 11-10 0H5z"/>' +
            '<path d="M7 20h10v2H7z"/>' +
          '</svg>' +
        '</span>',
      paused:
        '<svg class="w-5 h-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
          '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>' +
        '</svg>',
      stopped:
        '<svg class="w-5 h-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
          '<rect x="6" y="6" width="12" height="12" rx="2"/>' +
        '</svg>',
      requesting:
        '<svg class="w-5 h-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
          '<path d="M12 2a10 10 0 100 20 10 10 0 000-20zm1 5v5.2l3 1.8-.9 1.46L11 13V7h2z"/>' +
        '</svg>',
    };

    const htmlIcon = status === 'recording'  ? ICONS.recording
                    : status === 'paused'     ? ICONS.paused
                    : status === 'requesting' ? ICONS.requesting
                                               : ICONS.stopped;

    stateIcon.outerHTML = `<span id="stateIcon" class="flex items-center">${htmlIcon}</span>`;
    stateIcon = $('stateIcon');
    stateLabel.textContent =
      status === 'recording'  ? 'Recording' :
      status === 'paused'     ? 'Paused' :
      status === 'requesting' ? 'Requesting mic…' :
                                'Stopped – not recording';
  }

  function setStatus(s) {
    // map internal 'ready' -> user-facing 'stopped'
    const chipState = (s === 'ready') ? 'stopped' : s;
    setStateChip(chipState);
    sessionStatus.textContent = s;

    if (s === 'recording')      setButtons({ start:false, pause:true,  resume:false, stop:true  });
    else if (s === 'paused')    setButtons({ start:false, pause:false, resume:true,  stop:true  });
    else if (s === 'requesting')setButtons({ start:false, pause:false, resume:false, stop:false });
    else                        setButtons({ start:true,  pause:false, resume:false, stop:false });
  }

  /* ---- Recorder events (keep in sync) ---- */
  recorder.on?.('meter', ({ rms, peak }) => {
    const pct = Math.max(0, Math.min(100, Math.round(rms * 140)));
    liveLevelBar.style.width = pct + '%';
    liveLevelText.textContent = `RMS: ${rms.toFixed(2)} · Peak: ${peak.toFixed(2)}`;
  });

  recorder.on?.('status', ({ status }) => {
    setStatus(status);
    if (status === 'recording') {
      bytes = 0; chunks = 0;
      sessionChunks.textContent = '0';
      sessionSize.textContent = '0 KB';
    }
    if (status === 'ready' || status === 'idle') refreshRecordings().catch(console.error);
  });

  recorder.on?.('chunk', ({ size }) => {
    chunks += 1; bytes += size;
    sessionChunks.textContent = String(chunks);
    sessionSize.textContent = fmtBytes(bytes);
  });
  recorder.on?.('stats', (s) => { sessionDuration.textContent = fmtTime(s?.durationMs || 0); });

  /* ---- Buttons: make UI optimistic ---- */
  btnStart.addEventListener('click', async () => {
    try {
      // immediate visual feedback while permission prompt shows
      setStatus('requesting');
      await recorder.start();          // may show a browser permission sheet
      setStatus('recording');          // in case the status event is delayed/missed
    } catch (e) {
      console.error(e);
      setStatus('idle');
      alert('Failed to start: ' + (e.message || e));
    }
  });

  btnPause.addEventListener('click', async () => {
    try { await recorder.pause(); setStatus('paused'); }
    catch (e) { console.error(e); alert('Failed to pause'); }
  });

  btnResume.addEventListener('click', async () => {
    try { await recorder.resume(); setStatus('recording'); }
    catch (e) { console.error(e); alert('Failed to resume'); }
  });

  btnStop.addEventListener('click', async () => {
    try { await recorder.stop(); setStatus('idle'); }
    catch (e) { console.error(e); alert('Failed to stop'); }
  });

  btnRefresh?.addEventListener('click', () => refreshRecordings().catch(console.error));

  /* ---- Recordings list ---- */
  async function refreshRecordings() {
    const list = await storage.listRecordings();
    recordingsList.innerHTML = '';
    for (const rec of list) recordingsList.appendChild(renderRecordingItem(rec));
  }

  function renderRecordingItem(rec) {
    const el = document.createElement('li');
    el.className = 'border border-slate-200 rounded-xl p-3 bg-white';
    el.innerHTML = `
      <div class="flex items-center justify-between gap-2">
        <div class="min-w-0">
          <div class="text-sm text-slate-500">${new Date(rec.createdAt).toLocaleString()}</div>
          <div class="text-sm break-all font-mono">${rec.id}</div>
          <div class="text-xs text-slate-500">Type: ${rec.mimeType} · Duration: ${(rec.durationMs/1000||0).toFixed(1)}s</div>
        </div>
        <div class="flex items-center gap-2">
          <button class="px-2 py-1 border rounded text-sm" data-act="play">Play</button>
          <button class="px-2 py-1 border rounded text-sm" data-act="export">Export</button>
          <button class="px-2 py-1 border rounded text-sm" data-act="manifest">Manifest</button>
          <button class="px-2 py-1 border rounded text-sm" data-act="inspect">Inspect</button>
          <button class="px-2 py-1 border rounded text-sm text-rose-600" data-act="delete">Delete</button>
        </div>
      </div>
      <div class="mt-3 hidden space-y-2" data-detail></div>
    `;

    const id = rec.id;
    const detail = el.querySelector('[data-detail]');

    el.querySelector('[data-act="play"]').addEventListener('click', async () => {
      try { await player.playInto(detail, id, playerMode?.value || 'mse'); }
      catch (e) { console.error(e); alert('Failed to play: ' + (e.message || e)); }
    });

    el.querySelector('[data-act="export"]').addEventListener('click', async () => {
      try {
        const manifest = await storage.getManifest(id);
        const chunks = await storage.getChunksWithTiming(id);
        if (manifest?.format === 'pcm-f32') {
          const url = await assembleWavUrl(chunks, manifest.sampleRate || 48000);
          const a = document.createElement('a'); a.href = url; a.download = `recording-${id}.wav`;
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(()=>URL.revokeObjectURL(url), 20000);
        } else {
          const type = chunks[0]?.blob?.type || 'audio/webm';
          const url = URL.createObjectURL(new Blob(chunks.map(c=>c.blob), { type }));
          const a = document.createElement('a'); a.href = url; a.download = `recording-${id}.${type.includes('mp4')?'m4a':'webm'}`;
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(()=>URL.revokeObjectURL(url), 20000);
        }
      } catch (e) { console.error(e); alert('Export failed'); }
    });

    el.querySelector('[data-act="manifest"]').addEventListener('click', async () => {
      try {
        const m = await storage.getManifest(id);
        const url = URL.createObjectURL(new Blob([JSON.stringify(m, null, 2)], { type: 'application/json' }));
        const a = document.createElement('a'); a.href = url; a.download = `manifest-${id}.json`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(()=>URL.revokeObjectURL(url), 20000);
      } catch (e) { console.error(e); alert('Manifest export failed'); }
    });

    el.querySelector('[data-act="inspect"]').addEventListener('click', async () => {
      try {
        const rows = await storage.getChunksWithTiming(id);
        const html = rows.map(r=>`<tr>
          <td class="px-2 py-1">${r.index}</td>
          <td class="px-2 py-1">${(r.size/1024).toFixed(1)} KB</td>
          <td class="px-2 py-1">${(r.startMs/1000).toFixed(2)}s → ${(r.endMs/1000).toFixed(2)}s</td>
        </tr>`).join('');
        detail.classList.remove('hidden');
        detail.innerHTML = `
          <div class="overflow-x-auto border border-slate-200 rounded">
            <table class="min-w-full text-sm">
              <thead class="bg-slate-50 text-slate-600">
                <tr><th class="text-left px-2 py-1">#</th><th class="text-left px-2 py-1">Size</th><th class="text-left px-2 py-1">Timeline</th></tr>
              </thead>
              <tbody>${html}</tbody>
            </table>
          </div>
        `;
      } catch (e) { console.error(e); alert('Inspect failed'); }
    });

    el.querySelector('[data-act="delete"]').addEventListener('click', async () => {
      const ok = confirm('Delete this recording permanently?');
      if (!ok) return;
      try { await storage.deleteRecording(id); el.remove(); }
      catch (e) { console.error(e); alert('Delete failed'); }
    });

    return el;
  }

  async function assembleWavUrl(chunks, rate) {
    let total = 0; const parts = [];
    for (const c of chunks) { const ab = await c.blob.arrayBuffer(); const f = new Float32Array(ab); total += f.length; parts.push(f); }
    const f32 = new Float32Array(total);
    let off = 0; for (const p of parts) { f32.set(p, off); off += p.length; }
    const wav = pcm16Wav(f32, rate);
    return URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
  }
  function pcm16Wav(float32, sampleRate) {
    const numChannels = 1, bytesPerSample = 2, blockAlign = numChannels * bytesPerSample, byteRate = sampleRate * blockAlign;
    const dataSize = float32.length * bytesPerSample, buffer = new ArrayBuffer(44 + dataSize), view = new DataView(buffer);
    writeString(view, 0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    writeString(view, 36, 'data'); view.setUint32(40, dataSize, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, byteRate, true); view.setUint16(32, blockAlign, true); view.setUint16(34, 16, true);
    let offset = 44; for (let i = 0; i < float32.length; i++, offset += 2) {
      const s = Math.max(-1, Math.min(1, float32[i])); view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return buffer;
  }
  function writeString(view, offset, str) { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); }

  // First render
  (async () => { try { await refreshRecordings(); } catch (e) { console.error(e); } })();
  setStatus('idle');
}


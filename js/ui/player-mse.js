// player-mse.js
// If recording is PCM (manifest.format === 'pcm-f32'): assemble to WAV.
// Else (webm/mp4): use MSE sequence (unchanged), with concat fallback.

export const Player = ({ storage }) => {
  async function playInto(detailEl, recordingId, prefer = 'mse') {
    const manifest = await storage.getManifest(recordingId);
    const chunks = await storage.getChunksWithTiming(recordingId);
    if (!chunks.length) throw new Error('No chunks to play');

    if (manifest?.format === 'pcm-f32') {
      // Assemble WAV from Float32 slices
      const url = await buildWavUrlFromPCM(chunks, manifest?.sampleRate || 48000);
      return renderAudio(detailEl, url, `WAV (PCM ${manifest?.sampleRate || 48000} Hz)`);
    }

    // Non-PCM (webm/mp4) path
    const meta = await storage.getRecording(recordingId);
    const mimeCandidates = [
      meta?.mimeType,
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4;codecs=mp4a.40.2',
      'audio/mp4'
    ].filter(Boolean);
    const supportedMime = mimeCandidates.find((m) => window.MediaSource?.isTypeSupported?.(m)) || null;

    if (prefer === 'mse' && supportedMime && window.MediaSource) {
      try {
        await playMSESequence(detailEl, chunks, supportedMime);
        return;
      } catch (e) {
        console.warn('[MSE sequence] failed, falling back to concatenated WebM:', e);
      }
    }
    await playConcatenatedWebM(detailEl, chunks);
  }

  /* ---------- PCM → WAV ---------- */
  async function buildWavUrlFromPCM(chunks, sampleRate) {
    // Concatenate all Float32 arrays
    let total = 0;
    const parts = [];
    for (const c of chunks) {
      const ab = await c.blob.arrayBuffer();
      const f32 = new Float32Array(ab);
      total += f32.length;
      parts.push(f32);
    }
    const mono = new Float32Array(total);
    let off = 0; for (const p of parts) { mono.set(p, off); off += p.length; }

    const wavAB = pcm16Wav(mono, sampleRate);
    return URL.createObjectURL(new Blob([wavAB], { type: 'audio/wav' }));
  }

  function pcm16Wav(float32, sampleRate) {
    const numChannels = 1;
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = float32.length * bytesPerSample;

    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    writeString(view, 0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true); view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true); view.setUint16(32, blockAlign, true); view.setUint16(34, 16, true);
    writeString(view, 36, 'data'); view.setUint32(40, dataSize, true);

    let offset = 44;
    for (let i = 0; i < float32.length; i++, offset += 2) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return buffer;
  }
  function writeString(view, offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  /* ---------- WebM/MP4 via MSE (sequence) ---------- */
  async function playMSESequence(detailEl, chunks, mime) {
    const mediaSource = new MediaSource();
    const url = URL.createObjectURL(mediaSource);
    renderAudio(detailEl, url, `MSE sequence (${mime})`);

    await new Promise((resolve, reject) => {
      mediaSource.addEventListener('sourceopen', async () => {
        try {
          const sb = mediaSource.addSourceBuffer(mime);
          sb.mode = 'sequence';
          const waitEnd = () => new Promise(res => {
            const h = () => { sb.removeEventListener('updateend', h); res(); };
            sb.addEventListener('updateend', h);
          });

          for (const c of chunks) {
            const ab = await c.blob.arrayBuffer();
            if (sb.updating) await waitEnd();
            sb.appendBuffer(ab);
            await waitEnd();
          }
          if (mediaSource.readyState === 'open' && !sb.updating) {
            try { mediaSource.endOfStream(); } catch {}
          }
          resolve();
        } catch (err) {
          try { mediaSource.endOfStream('network'); } catch {}
          reject(err);
        }
      }, { once: true });
    });
  }

  /* ---------- Fallback: concatenate to one media blob ---------- */
  async function playConcatenatedWebM(detailEl, chunks) {
    const type = chunks[0]?.blob?.type || 'audio/webm';
    const big = new Blob(chunks.map(c => c.blob), { type });
    const url = URL.createObjectURL(big);
    renderAudio(detailEl, url, `Concatenated (${type})`);
  }

  function renderAudio(detailEl, srcUrl, label) {
    detailEl.classList.remove('hidden');
    detailEl.innerHTML = `
      <div class="border border-slate-200 rounded-lg p-3 bg-slate-50">
        <div class="text-sm text-slate-600 mb-2">Inline preview — ${label}</div>
        <audio controls preload="metadata" style="width:100%" src="${srcUrl}"></audio>
      </div>
    `;
    const audio = detailEl.querySelector('audio');
    const revoke = () => URL.revokeObjectURL(srcUrl);
    audio.addEventListener('ended', revoke, { once: true });
    audio.addEventListener('error', revoke, { once: true });
    audio.play().catch(()=>{});
  }

  return { playInto };
};


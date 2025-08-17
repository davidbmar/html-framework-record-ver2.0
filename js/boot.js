// web/record-ver2.0/js/boot.js

async function probe(url) {
  const full = new URL(url, import.meta.url).href; // resolve relative to THIS file
  try {
    const r = await fetch(full, { method: 'GET', cache: 'no-store' });
    if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
    console.log(`[probe] ✅ ${full}`);
    return full;
  } catch (e) {
    const msg = `[probe] ❌ ${full} — ${e.message || e}`;
    console.error(msg);
    const box = document.getElementById('boot-errors');
    if (box) {
      const div = document.createElement('div');
      div.textContent = msg;
      div.className = 'text-rose-700';
      box.appendChild(div);
    }
    throw e;
  }
}

(async () => {
  // Diagnostics box if index.html didn’t already create it
  if (!document.getElementById('boot-errors')) {
    const diag = document.createElement('div');
    diag.id = 'boot-errors';
    diag.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, monospace';
    diag.style.fontSize = '12px';
    diag.style.margin = '8px 0';
    document.body.prepend(diag);
  }

  // Paths are RELATIVE TO THIS FILE (/web/record-ver2.0/js/boot.js)
  const paths = [
    './adapters/storage-indexeddb.js',
    './recorder-box.js',
    './ui/player-mse.js',
    './ui/harness.js',
    '../css/harness.css', // CSS probe only
  ];

  for (const p of paths) await probe(p);

  // Dynamic imports (relative to this file)
  const { createIndexedDbStorage } = await import('./adapters/storage-indexeddb.js');
  const { createRecorderBox }     = await import('./recorder-box.js');
  const { initHarnessUI }         = await import('./ui/harness.js');

  const chunkSecondsEl = document.getElementById('chunkSeconds');
  const mimeTypeEl     = document.getElementById('mimeType');

  const storage = await createIndexedDbStorage({ dbName: 'recorder-v2', version: 6 });
  console.log('[init] IndexedDB storage ready');

  const recorder = await createRecorderBox({
    storage,
    chunkSeconds: Number(chunkSecondsEl?.value) || 2,
    mimeType: mimeTypeEl?.value
  });
  console.log('[init] Recorder ready');

  initHarnessUI({ recorder, storage });
})().catch(err => {
  console.error('[boot] init failed:', err);
});


// IndexedDB adapter that stores per-chunk timing for MSE/PCM playback
export async function createIndexedDbStorage({ dbName = 'recorder-v2', version = 6 } = {}) {
  const db = await openDb(dbName, version, (db) => {
    if (!db.objectStoreNames.contains('recordings')) {
      const recs = db.createObjectStore('recordings', { keyPath: 'id' });
      try { recs.createIndex('by_createdAt', 'createdAt', { unique: false }); } catch {}
      try { recs.createIndex('by_status', 'status', { unique: false }); } catch {}
    }
    if (!db.objectStoreNames.contains('chunks')) {
      const chunks = db.createObjectStore('chunks', { keyPath: ['recordingId','index'] });
      try { chunks.createIndex('by_recording', 'recordingId', { unique: false }); } catch {}
    }
    if (!db.objectStoreNames.contains('manifests')) {
      db.createObjectStore('manifests', { keyPath: 'recordingId' });
    }
  });

  /* -------- recordings -------- */
  async function putRecording(rec) {
    const tx = db.transaction(['recordings'], 'readwrite');
    tx.objectStore('recordings').put(rec);
    await txDone(tx);
  }
  async function getRecording(id) {
    const tx = db.transaction(['recordings'], 'readonly');
    const rec = await fromReq(tx.objectStore('recordings').get(id));
    await txDone(tx);
    return rec || null;
  }
  async function listRecordings() {
    const tx = db.transaction(['recordings'], 'readonly');
    const items = (await fromReq(tx.objectStore('recordings').getAll())) || [];
    await txDone(tx);
    items.sort((a,b)=>(b?.createdAt||0)-(a?.createdAt||0));
    return items;
  }
  async function setDuration(id, ms) {
    const r = await getRecording(id); if (!r) return;
    r.durationMs = ms; r.updatedAt = Date.now();
    await putRecording(r);
  }
  async function markStatus(id, status) {
    const r = await getRecording(id); if (!r) return;
    r.status = status; r.updatedAt = Date.now();
    await putRecording(r);
  }

  /* -------- manifests -------- */
  async function setManifest(id, manifest) {
    const tx = db.transaction(['manifests'], 'readwrite');
    tx.objectStore('manifests').put({ recordingId: id, ...manifest });
    await txDone(tx);
  }
  async function getManifest(recordingId) {
    const tx = db.transaction(['manifests'], 'readonly');
    const m = await fromReq(tx.objectStore('manifests').get(recordingId));
    await txDone(tx);
    return m || null;
  }

  /* -------- chunks (with timing) -------- */
  async function putChunk({ recordingId, index, blob, size, startMs, endMs }) {
    const tx = db.transaction(['chunks'], 'readwrite');
    tx.objectStore('chunks').put({ recordingId, index, blob, size, startMs, endMs });
    await txDone(tx);
  }

  async function getChunksWithTiming(recordingId) {
    const tx = db.transaction(['chunks'], 'readonly');
    const store = tx.objectStore('chunks');
    const rows = await fromReq(store.getAll());
    await txDone(tx);
    const out = rows
      .filter(r => r.recordingId === recordingId)
      .sort((a,b)=>(a.index||0)-(b.index||0))
      .map(({ blob, size, startMs, endMs, index }) => ({ blob, size, startMs, endMs, index }));
    return out;
  }

  // legacy helpers used by UI
  async function getChunksArray(recordingId) {
    const rows = await getChunksWithTiming(recordingId);
    return rows.map(r => r.blob);
  }
  async function countChunks(recordingId) {
    const rows = await getChunksWithTiming(recordingId);
    return rows.length;
  }

  /* -------- deletion -------- */
  async function deleteRecording(recordingId) {
    // Delete chunks
    {
      const tx = db.transaction(['chunks'], 'readwrite');
      const store = tx.objectStore('chunks');
      // Use index if available for efficiency
      if (safeHasIndex(store, 'by_recording')) {
        const idx = store.index('by_recording');
        let cur = await fromReq(idx.openCursor(IDBKeyRange.only(recordingId)));
        while (cur) { await fromReq(store.delete(cur.primaryKey)); cur = await fromReq(cur.continue()); }
      } else {
        let cur = await fromReq(store.openCursor());
        while (cur) {
          const v = cur.value;
          if ((Array.isArray(cur.key) && cur.key[0] === recordingId) || v?.recordingId === recordingId) {
            await fromReq(store.delete(cur.primaryKey));
          }
          cur = await fromReq(cur.continue());
        }
      }
      await txDone(tx);
    }
    // Delete manifest
    {
      const tx = db.transaction(['manifests'], 'readwrite');
      tx.objectStore('manifests').delete(recordingId);
      await txDone(tx);
    }
    // Delete recording row
    {
      const tx = db.transaction(['recordings'], 'readwrite');
      tx.objectStore('recordings').delete(recordingId);
      await txDone(tx);
    }
  }

  async function deleteAll() {
    const tx = db.transaction(['recordings','manifests','chunks'], 'readwrite');
    tx.objectStore('recordings').clear();
    tx.objectStore('manifests').clear();
    tx.objectStore('chunks').clear();
    await txDone(tx);
  }

  return {
    // recordings
    putRecording, getRecording, listRecordings, setDuration, markStatus,
    // manifests
    setManifest, getManifest,
    // chunks
    putChunk, getChunksWithTiming, getChunksArray, countChunks,
    // delete
    deleteRecording, deleteAll,
  };
}

/* ---------------- helpers ---------------- */
function openDb(name, version, onUpgrade) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = (e) => { try { onUpgrade(req.result, e.oldVersion||0, e.newVersion||version); } catch (err) { console.error('[idb upgrade]', err);} };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function fromReq(req) {
  return new Promise((resolve, reject) => {
    if (!req) return resolve(null);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}
function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
}
function safeHasIndex(store, name) {
  try {
    if (store.indexNames && typeof store.indexNames.contains === 'function') return store.indexNames.contains(name);
    store.index(name);
    return true;
  } catch { return false; }
}


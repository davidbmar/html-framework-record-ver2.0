// In-memory adapter (for tests). Non-persistent.
export function createMemoryStorage() {
  const recordings = new Map();
  const chunks = new Map();      // key: recordingId -> Map(index -> {blob,size})
  const manifests = new Map();

  return {
    async putRecording(rec) { recordings.set(rec.id, { ...rec }); },
    async touchRecording(id) { const r = recordings.get(id); if (r) r.updatedAt = Date.now(); },
    async setDuration(id, ms) { const r = recordings.get(id); if (r) r.durationMs = ms; },
    async setManifest(id, m) { manifests.set(id, { ...m }); },
    async markStatus(id, s) { const r = recordings.get(id); if (r) r.status = s; },
    async getRecording(id) { return recordings.get(id) || null; },
    async listRecordings() { return Array.from(recordings.values()).sort((a,b)=>b.createdAt-a.createdAt); },
    async countChunks(id) { const m = chunks.get(id); return m ? m.size : 0; },
    async putChunk({ recordingId, index, blob, size }) {
      if (!chunks.get(recordingId)) chunks.set(recordingId, new Map());
      chunks.get(recordingId).set(index, { blob, size });
    },
    async *getChunks(id) {
      const m = chunks.get(id);
      if (!m) return;
      const keys = Array.from(m.keys()).sort((a,b)=>a-b);
      for (const k of keys) yield m.get(k).blob;
    },
    async getManifest(id) { return manifests.get(id) || null; },
  };
}


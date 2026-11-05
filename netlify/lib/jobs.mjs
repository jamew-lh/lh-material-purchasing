// Staged uploads + AI reading jobs, kept in Netlify Blobs.
// A "job" holds the pages someone picked (photos / PDFs). The pages are read by the
// background worker and, when the order or delivery is saved, attached in Airtable.
import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';
import { HttpError } from './core.mjs';

const STORE = 'mp-uploads';
let store;
function blobs() {
  if (globalThis.__MP_TEST_STORE__) return globalThis.__MP_TEST_STORE__; // local tests
  return (store ||= getStore({ name: STORE, consistency: 'strong' }));
}

// Job ids start with the creation time so old, abandoned uploads can be found and removed.
const isJobId = (id) => /^[0-9a-z]{6,12}-[0-9a-f-]{36}$/.test(id || '');
const MAX_AGE_MS = 2 * 24 * 3600 * 1000;
const jobKey = (id) => `job/${id}`;
const fileKey = (id, n) => `file/${id}/${n}`;

export async function createJob({ kind = 'stage', orderId = '' } = {}) {
  if (Math.random() < 0.2) await sweepOld();
  const id = `${Date.now().toString(36)}-${crypto.randomUUID()}`;
  await blobs().setJSON(jobKey(id), { id, kind, orderId, status: 'staging', files: [], created: Date.now() });
  return id;
}

export async function getJob(id) {
  if (!isJobId(id)) throw new HttpError(400, 'Invalid upload id');
  const job = await blobs().get(jobKey(id), { type: 'json' });
  if (!job) throw new HttpError(404, 'Upload not found or expired. Please choose the pages again.');
  return job;
}

export async function saveJob(job) {
  await blobs().setJSON(jobKey(job.id), job);
  return job;
}

export async function addFile(id, { name, type, bytes }) {
  const job = await getJob(id);
  if (job.status !== 'staging') throw new HttpError(409, 'These pages are already being read');
  if (job.files.length >= 10) throw new HttpError(400, 'Up to 10 pages at a time');
  const n = job.files.length;
  await blobs().set(fileKey(id, n), bytes);
  job.files.push({ n, name: String(name || `page-${n + 1}`).slice(0, 150), type, size: bytes.byteLength });
  await saveJob(job);
  return job;
}

/** Returns [{name, type, base64}] for every staged page, in order. */
export async function loadFiles(job) {
  const out = [];
  for (const f of job.files) {
    const buf = await blobs().get(fileKey(job.id, f.n), { type: 'arrayBuffer' });
    if (!buf) throw new HttpError(404, 'A staged page has expired. Please choose the pages again.');
    out.push({ name: f.name, type: f.type, base64: Buffer.from(buf).toString('base64') });
  }
  return out;
}

export async function deleteJob(job) {
  try {
    for (const f of job.files) await blobs().delete(fileKey(job.id, f.n));
    await blobs().delete(jobKey(job.id));
  } catch { /* cleanup is best-effort */ }
}

/** Signature so only our own start request can trigger the background worker for a job. */
export function workerSig(id) {
  const secret = process.env.SESSION_SECRET || '';
  return crypto.createHmac('sha256', secret).update(`worker:${id}`).digest('base64url');
}

/** Removes uploads that were picked but never saved (older than two days). Best-effort. */
export async function sweepOld() {
  try {
    const { blobs: keys } = await blobs().list({ prefix: 'job/' });
    const cutoff = Date.now() - MAX_AGE_MS;
    for (const { key } of keys) {
      const id = key.slice(4);
      const born = parseInt(id.split('-')[0], 36);
      if (!born || born > cutoff) continue;
      const { blobs: files } = await blobs().list({ prefix: `file/${id}/` });
      for (const f of files) await blobs().delete(f.key);
      await blobs().delete(key);
    }
  } catch (e) {
    console.error('upload cleanup skipped', e.message);
  }
}

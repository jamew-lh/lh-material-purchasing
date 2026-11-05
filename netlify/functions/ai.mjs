// /api/ai — stage pages, start an AI read, and check on it.
//   POST ?action=start            {kind:'import'|'scan'|'stage', orderId?} -> {id}
//   POST ?action=file&id=&name=   raw file bytes (Content-Type = file type)  -> {pages}
//   POST ?action=run&id=          starts the background read                 -> {status}
//   GET  ?action=status&id=       -> {status:'queued'|'running'|'done'|'error', result?, error?, elapsed}
//   POST ?action=runNow&id=       quick in-request read (fallback if background jobs aren't available)
import { handler, json, readBody, requireAuth, HttpError, IMAGE_TYPES, MAX_FILE_BYTES } from '../lib/core.mjs';
import { createJob, getJob, saveJob, addFile, loadFiles, workerSig } from '../lib/jobs.mjs';
import { runReader } from '../lib/readers.mjs';

const KINDS = ['import', 'scan', 'stage'];
const isRec = (id) => /^rec[A-Za-z0-9]{14}$/.test(id || '');

export default handler(async (req) => {
  requireAuth(req, 'admin');
  const url = new URL(req.url);
  const action = url.searchParams.get('action');
  const id = url.searchParams.get('id');

  if (action === 'start' && req.method === 'POST') {
    const { kind = 'stage', orderId = '' } = await readBody(req);
    if (!KINDS.includes(kind)) throw new HttpError(400, 'Unknown upload type');
    if (kind === 'scan' && !isRec(orderId)) throw new HttpError(400, 'Missing order');
    return json({ id: await createJob({ kind, orderId }) });
  }

  if (action === 'file' && req.method === 'POST') {
    const type = String(req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/pdf' && !IMAGE_TYPES.includes(type)) throw new HttpError(400, 'Pages must be photos (JPG/PNG) or PDFs');
    const bytes = await req.arrayBuffer();
    if (!bytes.byteLength) throw new HttpError(400, 'Empty file');
    if (bytes.byteLength > MAX_FILE_BYTES) throw new HttpError(400, 'Each page/file must be under 5 MB');
    const job = await addFile(id, { name: url.searchParams.get('name'), type, bytes });
    return json({ pages: job.files.length });
  }

  if (action === 'run' && req.method === 'POST') {
    const job = await getJob(id);
    if (!job.files.length) throw new HttpError(400, 'Add at least one page first');
    if (job.kind === 'stage') throw new HttpError(400, 'Nothing to read for this upload');
    if (job.status === 'staging' || job.status === 'error') {
      Object.assign(job, { status: 'queued', queuedAt: Date.now(), error: null, result: null });
      await saveJob(job);
      // Kick off the background worker (runs up to 15 minutes; Netlify answers 202 right away).
      try {
        await fetch(new URL('/api/ai-worker', url), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: job.id, sig: workerSig(job.id) }),
        });
      } catch (e) {
        console.error('worker trigger failed', e); // the page falls back to runNow if the job never starts
      }
    }
    return json({ status: job.status });
  }

  if (action === 'status' && req.method === 'GET') {
    const job = await getJob(id);
    return json({
      status: job.status,
      result: job.status === 'done' ? job.result : undefined,
      error: job.status === 'error' ? job.error : undefined,
      elapsed: job.queuedAt ? Math.round((Date.now() - job.queuedAt) / 1000) : 0,
    });
  }

  if (action === 'runNow' && req.method === 'POST') {
    const job = await getJob(id);
    if (job.status === 'done') return json({ status: 'done', result: job.result });
    if (job.status === 'running') return json({ status: 'running' }); // the worker did start after all
    Object.assign(job, { status: 'running', startedAt: Date.now(), via: 'direct' });
    await saveJob(job);
    try {
      const result = await runReader(job, await loadFiles(job), { timeoutMs: 26000 });
      Object.assign(job, { status: 'done', result });
      await saveJob(job);
      return json({ status: 'done', result });
    } catch (e) {
      Object.assign(job, { status: 'error', error: e.message });
      await saveJob(job);
      throw e;
    }
  }

  throw new HttpError(404, 'Unknown action');
});

export const config = { path: '/api/ai' };

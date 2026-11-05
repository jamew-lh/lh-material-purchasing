// Background worker: reads the staged pages with Claude and stores the result on the job.
// Netlify runs background functions for up to 15 minutes and answers the caller with 202 immediately.
import { safeEqual } from '../lib/core.mjs';
import { getJob, saveJob, loadFiles, workerSig } from '../lib/jobs.mjs';
import { runReader } from '../lib/readers.mjs';

export default async (req) => {
  let job;
  try {
    const { id, sig } = await req.json();
    if (!sig || !safeEqual(sig, workerSig(id))) return new Response('forbidden', { status: 403 });
    job = await getJob(id);
    if (job.status !== 'queued') return new Response('skipped'); // already running/done (or a retry)
    Object.assign(job, { status: 'running', startedAt: Date.now(), via: 'background' });
    await saveJob(job);
    const result = await runReader(job, await loadFiles(job), { timeoutMs: 600000 });
    Object.assign(job, { status: 'done', result, finishedAt: Date.now() });
    await saveJob(job);
  } catch (e) {
    console.error('AI worker error', e);
    if (job) {
      Object.assign(job, { status: 'error', error: e.message || 'Reading failed' });
      await saveJob(job).catch(() => {});
    }
  }
  return new Response('ok'); // never error, so Netlify doesn't retry a finished job
};

export const config = { path: '/api/ai-worker', background: true };

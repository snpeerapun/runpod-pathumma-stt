#!/usr/bin/env node
/** Node 22+, no npm dependencies. Contract: README.md + handler.py in this folder. */
import { readFile, stat } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

export const MAX_AUDIO_BYTES = 6 * 1024 * 1024;
export async function payloadFor(audio, language = 'th') {
  const info = await stat(audio);
  if (!info.isFile() || info.size === 0 || info.size > MAX_AUDIO_BYTES) throw new Error('Audio must be a nonempty file, at most 6 MiB.');
  if (!['th', 'en'].includes(language)) throw new Error('Language must be th or en.');
  const bytes = await readFile(audio);
  return { input: { audio_base64: bytes.toString('base64'), language } };
}

export async function runJob({ endpoint, apiKey, payload, jobId, timeout = 600, interval = 2, fetcher = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), log = console.error }) {
  if (!/^[a-zA-Z0-9_-]+$/.test(endpoint || '')) throw new Error('Set RUNPOD_ENDPOINT_ID or --endpoint to an endpoint ID (not a URL).');
  if (!apiKey?.trim()) throw new Error('Set RUNPOD_API_KEY in your terminal environment.');
  if (!Number.isFinite(timeout) || timeout <= 0 || !Number.isFinite(interval) || interval <= 0) throw new Error('Timeout and interval must be positive seconds.');
  if (jobId && !/^[a-zA-Z0-9_-]+$/.test(jobId)) throw new Error('Invalid job ID.');
  const base = `https://api.runpod.ai/v2/${endpoint}`;
  const started = Date.now();
  const deadline = started + timeout * 1000;
  let knownId = jobId;
  const request = async (path, body) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Client wait timed out.');
    const response = await fetcher(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.min(60000, remaining)))
    });
    if (!response.ok) {
      const hint = { 401: 'Check API key.', 403: 'Check endpoint permissions.', 404: 'Check endpoint/job ID or result expiry.', 429: 'Rate limited; wait before checking this job again.' }[response.status] || 'Check RunPod endpoint logs.';
      throw new Error(`RunPod HTTP ${response.status}. ${hint}`);
    }
    return response.json();
  };
  try {
    // Never retry submission automatically: an ambiguous network failure can already have created a paid job.
    let job = await request(jobId ? `/status/${encodeURIComponent(jobId)}` : '/run', jobId ? undefined : payload);
    knownId = job.id || knownId;
    if (!knownId || !/^[a-zA-Z0-9_-]+$/.test(knownId)) throw new Error('Response has no valid job ID.');
    log(`Job: ${knownId}`);
    let previousStatus;
    while (true) {
      if (job.status !== previousStatus) { log(`Status: ${job.status}`); previousStatus = job.status; }
      if (job.status === 'COMPLETED') {
        if (job.output?.error || job.output?.ok === false) throw new Error('Worker returned an error. Check endpoint logs and input contract.');
        if (typeof job.output?.text !== 'string') throw new Error('Unexpected output: expected output.text. This script requires the included Pathumma worker contract.');
        return { job_id: knownId, status: job.status, ...job.output, delay_ms: job.delayTime ?? null, execution_ms: job.executionTime ?? null, client_elapsed_ms: Date.now() - started };
      }
      if (['FAILED', 'CANCELLED', 'TIMED_OUT'].includes(job.status)) throw new Error(`Job ${job.status}. Check RunPod worker logs.`);
      if (!['IN_QUEUE', 'IN_PROGRESS'].includes(job.status)) throw new Error(`Unexpected job status: ${job.status}`);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Client wait timed out.');
      await sleep(Math.min(interval * 1000, remaining));
      job = await request(`/status/${encodeURIComponent(knownId)}`);
    }
  } catch (error) {
    const hint = knownId
      ? `Job ID: ${knownId}. The job may still be running; inspect/resume with --job ${knownId}. This script does not cancel remote jobs.`
      : 'Submission may have reached RunPod. Check the endpoint Requests tab before resubmitting.';
    throw new Error(`${error.name === 'TimeoutError' ? 'Request timed out.' : error.message}\n${hint}`);
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    audio: { type: 'string' }, endpoint: { type: 'string' }, job: { type: 'string' },
    language: { type: 'string', default: 'th' }, timeout: { type: 'string', default: '600' },
    interval: { type: 'string', default: '2' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean' }
  } });
  if (values.help) {
    console.log(`Usage (Node.js 22+):
  node test-call.mjs --audio ./sample.wav [--endpoint ID]
  node test-call.mjs --audio ./sample.wav --dry-run
  node test-call.mjs --job JOB_ID [--endpoint ID]
Environment: RUNPOD_API_KEY, RUNPOD_ENDPOINT_ID
Options: --language th|en, --timeout 600, --interval 2 (seconds)
Input schema: {input:{audio_base64,language}}; requires the matching worker.
Stdout: result JSON. Stderr: job ID/progress. Dry run does not call RunPod.`);
    return;
  }
  if (Boolean(values.audio) === Boolean(values.job)) throw new Error('Provide exactly one of --audio FILE or --job ID.');
  if (values['dry-run'] && values.job) throw new Error('--dry-run requires --audio.');
  const payload = values.audio ? await payloadFor(values.audio, values.language) : undefined;
  if (values['dry-run']) {
    console.log(JSON.stringify({ dry_run: true, model: 'nectec/Pathumma-whisper-th-large-v3', endpoint: values.endpoint || process.env.RUNPOD_ENDPOINT_ID || '(not configured)', payload_bytes: Buffer.byteLength(JSON.stringify(payload)), input: { ...payload.input, audio_base64: `[${payload.input.audio_base64.length} base64 characters omitted]` } }, null, 2));
    return;
  }
  const result = await runJob({ endpoint: values.endpoint || process.env.RUNPOD_ENDPOINT_ID, apiKey: process.env.RUNPOD_API_KEY, payload, jobId: values.job, timeout: Number(values.timeout), interval: Number(values.interval) });
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });

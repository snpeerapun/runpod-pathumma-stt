import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { payloadFor, runJob } from './test-call.mjs';
const basic = { endpoint: 'endpoint-123', apiKey: 'test-secret', payload: { input: { audio_base64: 'AA==', language: 'th' } }, sleep: async () => {}, log: () => {} };
const response = data => new Response(JSON.stringify(data));
test('file encoded using the matching worker schema', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'pathumma-test-'));
  try {
    const file = join(folder, 'sample.wav');
    await writeFile(file, Buffer.from([0, 1, 2, 3]));
    assert.deepEqual(await payloadFor(file), { input: { audio_base64: 'AAECAw==', language: 'th' } });
    await writeFile(file, ''); await assert.rejects(payloadFor(file), /nonempty/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
test('submits once, polls status and returns transcription with timings', async () => {
  const calls = [];
  const states = [{ id: 'job-1', status: 'IN_QUEUE' }, { id: 'job-1', status: 'IN_PROGRESS' }, { id: 'job-1', status: 'COMPLETED', delayTime: 300, executionTime: 900, output: { ok: true, text: 'สวัสดี', model: 'nectec/Pathumma-whisper-th-large-v3' } }];
  const output = await runJob({ ...basic, fetcher: async (url, init) => { calls.push({ url, init }); return response(states.shift()); } });
  assert.equal(output.text, 'สวัสดี'); assert.equal(output.execution_ms, 900);
  assert.equal(calls.filter(call => call.init.method === 'POST').length, 1);
  assert.equal(calls[0].url, 'https://api.runpod.ai/v2/endpoint-123/run');
  assert.equal(calls[1].url, 'https://api.runpod.ai/v2/endpoint-123/status/job-1');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-secret');
  assert.equal(calls[0].init.redirect, 'error');
  assert.deepEqual(JSON.parse(calls[0].init.body), basic.payload);
});
test('resume never resubmits paid work', async () => {
  await runJob({ ...basic, jobId: 'existing-1', fetcher: async (url, init) => { assert.equal(init.method, 'GET'); assert.ok(url.endsWith('/status/existing-1')); return response({ id: 'existing-1', status: 'COMPLETED', output: { text: '' } }); } });
});
test('worker failures and incompatible output are not reported as success', async () => {
  for (const job of [
    { status: 'FAILED' }, { status: 'TIMED_OUT' },
    { status: 'COMPLETED', output: { error: 'bad input' } },
    { status: 'COMPLETED', output: { unexpected: true } }
  ]) await assert.rejects(runJob({ ...basic, fetcher: async () => response({ id: 'failed-job', ...job }) }));
});
test('ambiguous network failure is not retried and does not print credentials', async () => {
  let calls = 0;
  await assert.rejects(runJob({ ...basic, fetcher: async () => { calls++; throw new Error('fetch failed'); } }), error => error.message.includes('before resubmitting') && !error.message.includes(basic.apiKey));
  assert.equal(calls, 1);
});
test('auth errors are actionable without echoing server content', async () => {
  await assert.rejects(runJob({ ...basic, fetcher: async () => new Response('private diagnostics', { status: 401 }) }), /Check API key/);
});
test('invalid endpoint and missing credentials are rejected before network calls', async () => {
  const fetcher = async () => assert.fail('Network should not be called');
  await assert.rejects(runJob({ ...basic, endpoint: 'https://evil.test', fetcher }), /endpoint ID/);
  await assert.rejects(runJob({ ...basic, apiKey: '', fetcher }), /RUNPOD_API_KEY/);
});

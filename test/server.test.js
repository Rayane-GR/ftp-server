'use strict';

/**
 * Functional API tests for the file-sharing server.
 * Runs the real Express app on an ephemeral port with an isolated data dir.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

function startServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'appjet-share-test-'));
  const port = 3400 + Math.floor(Math.random() * 400);
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      MAX_FILE_BYTES: String(8 * 1024 * 1024),
      LINK_SECRET: 'test-secret',
      PUBLIC_BASE_URL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { child, dataDir, baseUrl: `http://127.0.0.1:${port}` };
}

async function waitFor(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server did not start: ${url}`);
}

async function upload(baseUrl, { name, content, expires = '7d', password = '' }) {
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'text/plain' }), name);
  form.append('expires', expires);
  if (password) form.append('password', password);
  const res = await fetch(`${baseUrl}/api/upload`, { method: 'POST', body: form });
  return { res, body: await res.json() };
}

test('file sharing server', async (t) => {
  const { child, dataDir, baseUrl } = startServer();
  const logs = [];
  child.stdout.on('data', (d) => logs.push(d.toString()));
  child.stderr.on('data', (d) => logs.push(d.toString()));

  t.after(() => {
    if (logs.length) console.error('CHILD LOGS:', logs.join(''));
    child.kill('SIGTERM');
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  await waitFor(`${baseUrl}/api/health`);

  await t.test('health reports a global (non-localhost) capable service', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.service, 'appjet-share');
    assert.equal(typeof body.https, 'boolean');
  });

  await t.test('landing page renders Arabic RTL markup with download button', async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /dir="rtl"/);
    assert.match(html, /تحميل التطبيق/);
    assert.match(html, /id="download-modal"/);
    assert.match(html, /id="download-modal"[^>]*hidden/);
  });

  await t.test('manifest and service worker are served for PWA install', async () => {
    const manifest = await fetch(`${baseUrl}/manifest.webmanifest`);
    assert.equal(manifest.status, 200);
    const json = await manifest.json();
    assert.equal(json.start_url, '/app');
    assert.ok(Array.isArray(json.icons) && json.icons.length >= 2);

    const sw = await fetch(`${baseUrl}/sw.js`);
    assert.equal(sw.status, 200);
    assert.match(await sw.text(), /addEventListener\('fetch'/);
  });

  let uploaded;

  await t.test('upload returns a global share URL and direct download URL', async () => {
    const payload = crypto.randomBytes(2048).toString('hex');
    const { res, body } = await upload(baseUrl, { name: 'test-file.txt', content: payload });
    assert.equal(res.status, 201);
    assert.equal(body.ok, true);
    assert.match(body.file.shareUrl, new RegExp(`^${baseUrl}/s/`));
    assert.match(body.file.downloadUrl, new RegExp(`^${baseUrl}/f/`));
    assert.equal(body.file.name, 'test-file.txt');
    assert.equal(body.file.size, Buffer.byteLength(payload));
    assert.ok(body.deleteToken && body.deleteToken.length > 20);
    uploaded = { ...body, payload };
  });

  await t.test('direct link downloads the exact bytes', async () => {
    const res = await fetch(uploaded.file.downloadUrl);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(text, uploaded.payload);
    const disposition = res.headers.get('content-disposition') || '';
    assert.match(disposition, /attachment/);
    assert.match(disposition, /filename\*=UTF-8''test-file\.txt/);
  });

  await t.test('share page and metadata endpoint work for the id', async () => {
    const page = await fetch(uploaded.file.shareUrl);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /id="share-root"/);

    const meta = await fetch(`${baseUrl}/api/files/${uploaded.file.id}`);
    assert.equal(meta.status, 200);
    const json = await meta.json();
    assert.equal(json.file.checksum, `sha256:${crypto.createHash('sha256').update(uploaded.payload).digest('hex')}`);
  });

  await t.test('downloads are counted', async () => {
    const list = await (await fetch(`${baseUrl}/api/files`)).json();
    const entry = list.files.find((f) => f.id === uploaded.file.id);
    assert.ok(entry.downloads >= 1, 'expected at least one counted download');
  });

  await t.test('password-protected upload requires the password', async () => {
    const { res, body } = await upload(baseUrl, {
      name: 'secret.txt',
      content: 'top secret content',
      password: 'pass-1234',
    });
    assert.equal(res.status, 201);
    assert.equal(body.file.locked, true);
    assert.equal(body.file.passwordHash, undefined);

    const direct = await fetch(body.file.downloadUrl, { redirect: 'manual' });
    assert.equal(direct.status, 302);

    const bad = await fetch(`${baseUrl}/api/files/${body.file.id}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' }),
    });
    assert.equal(bad.status, 401);

    const good = await fetch(`${baseUrl}/api/files/${body.file.id}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'pass-1234' }),
    });
    assert.equal(good.status, 200);
    const { token } = await good.json();
    assert.ok(token);

    const ok = await fetch(`${body.file.downloadUrl}?t=${encodeURIComponent(token)}`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), 'top secret content');
  });

  await t.test('delete requires the delete token and removes the file', async () => {
    const { body } = await upload(baseUrl, { name: 'temp.txt', content: 'temporary' });

    const forbidden = await fetch(`${baseUrl}/api/files/${body.file.id}`, { method: 'DELETE' });
    assert.equal(forbidden.status, 403);

    const ok = await fetch(`${baseUrl}/api/files/${body.file.id}`, {
      method: 'DELETE',
      headers: { 'x-delete-token': body.deleteToken },
    });
    assert.equal(ok.status, 200);

    const gone = await fetch(`${baseUrl}/api/files/${body.file.id}`);
    assert.equal(gone.status, 404);
  });

  await t.test('unknown file returns Arabic 404 and JSON for API', async () => {
    const html = await fetch(`${baseUrl}/f/does-not-exist`);
    assert.equal(html.status, 404);
    assert.match(await html.text(), /الملف غير موجود/);

    const api = await fetch(`${baseUrl}/api/files/does-not-exist`);
    assert.equal(api.status, 404);
    assert.equal((await api.json()).ok, false);
  });

  await t.test('metadata survives a restart (persistent storage)', async () => {
    await new Promise((r) => setTimeout(r, 300));
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));

    const port = new URL(baseUrl).port;
    const restarted = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
      env: { ...process.env, PORT: port, DATA_DIR: dataDir, LINK_SECRET: 'test-secret' },
      stdio: 'ignore',
    });
    t.after(() => restarted.kill('SIGTERM'));
    await waitFor(`${baseUrl}/api/health`);

    const res = await fetch(`${baseUrl}/f/${uploaded.file.id}`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), uploaded.payload);
  });

  await t.test('downloads API reports installer catalog shape', async () => {
    const res = await fetch(`${baseUrl}/api/downloads`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.builds));
    assert.ok(body.baseUrl.startsWith('http'));
  });
});

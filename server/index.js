'use strict';

const express = require('express');
const multer = require('multer');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const { DATA_DIR, UPLOAD_DIR, TMP_DIR, PUBLIC_DIR } = require('./paths');
const store = require('./store');

const PORT = Number(process.env.PORT || 3000);
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES || 2 * 1024 * 1024 * 1024);
const MAX_TOTAL_BYTES = Number(process.env.MAX_TOTAL_BYTES || 8 * 1024 * 1024 * 1024);
const DEFAULT_TTL_HOURS = Number(process.env.DEFAULT_TTL_HOURS || 0);
const DOWNLOAD_DIR = path.join(PUBLIC_DIR, 'downloads');

/* ------------------------------------------------------------------ *
 * server secret (used to sign short-lived download tokens)
 * ------------------------------------------------------------------ */
function loadSecret() {
  if (process.env.LINK_SECRET) return process.env.LINK_SECRET;
  const file = path.join(DATA_DIR, 'secret.key');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  }
}
const SECRET = loadSecret();

function signPayload(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

function makeDownloadToken(id, ttlMs = 10 * 60 * 1000) {
  const exp = Date.now() + ttlMs;
  const payload = `${id}.${exp}`;
  return `${exp}.${signPayload(payload)}`;
}

function verifyDownloadToken(id, token) {
  if (typeof token !== 'string') return false;
  const [expRaw, sig] = token.split('.');
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < Date.now() || !sig) return false;
  const expected = signPayload(`${id}.${exp}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */
function baseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const host = (req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`)
    .split(',')[0]
    .trim();
  const forwarded = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const localHost = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
  // Behind a TLS-terminating proxy the forwarding header may be missing entirely,
  // so any non-local public host is assumed to be served over HTTPS.
  const proto = forwarded || (localHost ? req.protocol || 'http' : 'https');
  return `${proto}://${host}`;
}

function parseTtl(value) {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_TTL_HOURS > 0 ? Date.now() + DEFAULT_TTL_HOURS * 3600 * 1000 : null;
  }
  const map = { '1h': 1, '24h': 24, '7d': 168, '30d': 720 };
  const key = String(value).trim();
  if (key === 'never' || key === '0') return null;
  if (map[key]) return Date.now() + map[key] * 3600 * 1000;
  return Date.now() + DEFAULT_TTL_HOURS * 3600 * 1000 || null;
}

function safeFilename(name) {
  const base = path.basename(String(name || 'file'));
  const cleaned = base.replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_').trim();
  return (cleaned || 'file').slice(0, 180);
}

function contentDisposition(kind, filename) {
  const ascii = filename.replace(/[^\x20-\x7e]+/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** Tiny in-memory rate limiter for write endpoints. */
const buckets = new Map();
function rateLimit({ windowMs = 60_000, max = 30 } = {}) {
  return (req, res, next) => {
    const key = `${req.ip}`;
    const now = Date.now();
    const bucket = buckets.get(key) || { count: 0, reset: now + windowMs };
    if (now > bucket.reset) {
      bucket.count = 0;
      bucket.reset = now + windowMs;
    }
    bucket.count += 1;
    buckets.set(key, bucket);
    if (buckets.size > 5000) {
      for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k);
    }
    if (bucket.count > max) {
      res.status(429).json({ ok: false, error: 'عدد كبير من الطلبات، حاول بعد قليل.' });
      return;
    }
    next();
  };
}

/* ------------------------------------------------------------------ *
 * uploads
 * ------------------------------------------------------------------ */
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, TMP_DIR),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`),
  }),
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
});

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));

/* ---------------------------- API --------------------------------- */

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'appjet-share',
    version: require('../package.json').version,
    uptimeSeconds: Math.round(process.uptime()),
    https: baseUrl(req).startsWith('https://'),
    time: new Date().toISOString(),
  });
});

app.get('/api/stats', async (req, res) => {
  await store.sweepExpired();
  const s = store.stats();
  res.json({
    ok: true,
    files: s.files,
    totalBytes: s.totalBytes,
    downloads: s.downloads,
    freeBytes: s.freeBytes,
    maxFileBytes: MAX_FILE_BYTES,
    baseUrl: baseUrl(req),
  });
});

app.get('/api/files', async (req, res) => {
  await store.sweepExpired();
  const base = baseUrl(req);
  const limit = Math.min(Number(req.query.limit || 24), 60);
  const items = store.list().slice(0, limit).map((f) => store.toPublic(f, base));
  res.json({ ok: true, count: items.length, files: items });
});

app.get('/api/files/:id', (req, res) => {
  const entry = store.get(req.params.id);
  if (!entry || (entry.expiresAt && entry.expiresAt <= Date.now())) {
    res.status(404).json({ ok: false, error: 'الملف غير موجود أو انتهت صلاحية الرابط.' });
    return;
  }
  res.json({ ok: true, file: store.toPublic(entry, baseUrl(req)) });
});

app.post('/api/upload', rateLimit({ max: 40 }), (req, res, next) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return next(err);
    if (!req.file) {
      res.status(400).json({ ok: false, error: 'لم يتم إرسال أي ملف.' });
      return;
    }
    const tmpPath = req.file.path;
    try {
      const s = store.stats();
      if (s.totalBytes + req.file.size > MAX_TOTAL_BYTES) {
        await fsp.rm(tmpPath, { force: true });
        res.status(507).json({
          ok: false,
          error: 'مساحة الخادم ممتلئة. احذف بعض الملفات ثم أعد المحاولة.',
        });
        return;
      }

      const id = store.newId();
      const storedName = id;
      const finalPath = path.join(UPLOAD_DIR, storedName);
      await fsp.rename(tmpPath, finalPath);

      const password = (req.body?.password || '').toString().trim() || null;
      const expiresAt = parseTtl(req.body?.expires);
      const checksum = await store.sha256File(finalPath);
      const { entry, deleteToken } = store.createEntry({
        id,
        name: safeFilename(req.file.originalname),
        size: req.file.size,
        mime: req.file.mimetype,
        storedName,
        password,
        expiresAt,
        checksum,
      });
      await store.flush();

      const base = baseUrl(req);
      res.status(201).json({
        ok: true,
        file: store.toPublic(entry, base),
        deleteToken,
        message: 'تم الرفع بنجاح. الرابط جاهز للمشاركة عالميًا.',
      });
    } catch (e) {
      await fsp.rm(tmpPath, { force: true }).catch(() => {});
      next(e);
    }
  });
});

app.post('/api/files/:id/unlock', rateLimit({ max: 60 }), (req, res) => {
  const entry = store.get(req.params.id);
  if (!entry) {
    res.status(404).json({ ok: false, error: 'الملف غير موجود.' });
    return;
  }
  if (!entry.passwordHash) {
    res.json({ ok: true, token: null });
    return;
  }
  if (!store.verifyPassword(req.body?.password, entry.passwordHash)) {
    res.status(401).json({ ok: false, error: 'كلمة المرور غير صحيحة.' });
    return;
  }
  res.json({ ok: true, token: makeDownloadToken(entry.id) });
});

app.delete('/api/files/:id', rateLimit({ max: 60 }), async (req, res) => {
  const token = req.headers['x-delete-token'] || req.query.token;
  if (!store.verifyDeleteToken(req.params.id, token)) {
    res.status(403).json({ ok: false, error: 'رمز الحذف غير صحيح.' });
    return;
  }
  const removed = await store.removeFile(req.params.id);
  if (!removed) {
    res.status(404).json({ ok: false, error: 'الملف غير موجود.' });
    return;
  }
  await store.flush();
  res.json({ ok: true, message: 'تم حذف الملف نهائيًا.' });
});

/* ------------------------ downloads / share ----------------------- */

function streamFile(req, res, entry) {
  const filePath = path.join(UPLOAD_DIR, entry.storedName);
  if (!fs.existsSync(filePath)) {
    res.status(410).json({ ok: false, error: 'الملف لم يعد موجودًا على الخادم.' });
    return;
  }
  res.setHeader('Content-Type', entry.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', contentDisposition('attachment', entry.name));
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('ETag', `"${entry.checksum || entry.id}"`);
  res.setHeader('Accept-Ranges', 'bytes');
  res.sendFile(
    filePath,
    { acceptRanges: true, cacheControl: false, lastModified: true },
    (err) => {
      if (!err) return;
      if (!res.headersSent) res.status(500).json({ ok: false, error: 'تعذر إرسال الملف.' });
    },
  );
  res.on('finish', () => {
    if (res.statusCode < 400) store.incrementDownloads(entry.id);
  });
}

app.get('/f/:id', (req, res) => {
  const entry = store.get(req.params.id);
  if (!entry) {
    res.status(404).type('html').sendFile(path.join(PUBLIC_DIR, '404.html'));
    return;
  }
  if (entry.expiresAt && entry.expiresAt <= Date.now()) {
    store.removeFile(entry.id);
    res.status(410).type('html').sendFile(path.join(PUBLIC_DIR, '404.html'));
    return;
  }
  if (entry.passwordHash && !verifyDownloadToken(entry.id, req.query.t)) {
    res.redirect(302, `/s/${entry.id}`);
    return;
  }
  streamFile(req, res, entry);
});

app.get('/s/:id', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(PUBLIC_DIR, 'share.html'));
});

/* ------------------------- installer files ------------------------ */

function listBuilds() {
  try {
    const raw = fs.readFileSync(path.join(DOWNLOAD_DIR, 'manifest.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return { builds: [] };
  }
}

app.get('/api/downloads', (req, res) => {
  const manifest = listBuilds();
  const base = baseUrl(req);
  const builds = (manifest.builds || []).map((b) => ({
    ...b,
    url: `${base}/downloads/${encodeURIComponent(b.file)}`,
    available: fs.existsSync(path.join(DOWNLOAD_DIR, b.file)),
  }));
  res.json({ ok: true, baseUrl: base, https: base.startsWith('https://'), builds });
});

app.use(
  '/downloads',
  express.static(DOWNLOAD_DIR, {
    setHeaders: (res, filePath) => {
      if (/\.(apk|exe|msi|dmg|ipa)$/i.test(filePath)) {
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Cache-Control', 'public, max-age=300');
      }
    },
  }),
);

/* --------------------------- static app -------------------------- */

app.get('/manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json').sendFile(path.join(PUBLIC_DIR, 'manifest.webmanifest'));
});

app.get('/sw.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('application/javascript').sendFile(path.join(PUBLIC_DIR, 'sw.js'));
});

app.get('/app', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'app.html')));
app.get('/download', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'download.html')));

app.use(express.static(PUBLIC_DIR, { extensions: ['html'], maxAge: '1h' }));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ ok: false, error: 'المسار غير موجود.' });
    return;
  }
  res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'));
});

/* --------------------------- errors ------------------------------ */

app.use((err, req, res, _next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({
      ok: false,
      error: `حجم الملف أكبر من الحد المسموح (${Math.round(MAX_FILE_BYTES / (1024 * 1024))} ميجابايت).`,
    });
    return;
  }
  const status = err?.status || 500;
  if (status >= 500) console.error('[server]', err);
  if (req.path.startsWith('/api/') || req.get('accept')?.includes('application/json')) {
    res.status(status).json({ ok: false, error: 'حدث خطأ غير متوقع في الخادم.' });
    return;
  }
  res.status(status).type('text').send('حدث خطأ غير متوقع.');
});

/* --------------------------- startup ----------------------------- */

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[appjet-share] listening on 0.0.0.0:${PORT}`);
  console.log(`[appjet-share] data dir: ${DATA_DIR}`);
  store
    .sweepExpired()
    .then((n) => n && console.log(`[appjet-share] cleaned ${n} expired file(s)`))
    .catch(() => {});
});

setInterval(() => store.sweepExpired().catch(() => {}), 30 * 60 * 1000).unref();

async function shutdown(signal) {
  console.log(`[appjet-share] ${signal} received, shutting down`);
  server.close(() => {});
  await store.flush().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;

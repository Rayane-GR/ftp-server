'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { META_FILE, DATA_DIR, UPLOAD_DIR } = require('./paths');

const EMPTY = { version: 1, files: {} };

/** In-memory mirror of the metadata store, flushed atomically to disk. */
let state = load();
let flushTimer = null;
let flushing = Promise.resolve();

function load() {
  try {
    const raw = fs.readFileSync(META_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.files && typeof parsed.files === 'object') {
      return parsed;
    }
  } catch {
    /* first run or corrupt file -> start clean */
  }
  return structuredClone(EMPTY);
}

function scheduleFlush() {
  if (flushTimer) return flushing;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushing = flush().catch(() => {});
  }, 60);
  flushTimer.unref?.();
  return flushing;
}

let flushSeq = 0;
let flushChain = Promise.resolve();

/**
 * Atomically persist metadata. Flushes are serialised and each temp file name
 * is unique, otherwise two concurrent flushes can rename the same temp path
 * and crash the process with ENOENT.
 */
function flush() {
  flushSeq += 1;
  const tmp = path.join(DATA_DIR, `.files.${process.pid}.${flushSeq}.tmp`);
  const payload = JSON.stringify(state, null, 2);
  flushChain = flushChain
    .catch(() => {})
    .then(() => fsp.writeFile(tmp, payload, 'utf8'))
    .then(() => fsp.rename(tmp, META_FILE))
    .catch(async (err) => {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      console.error('[store] فشل حفظ بيانات الملفات:', err.message);
    });
  return flushChain;
}

function newId() {
  return crypto.randomBytes(9).toString('base64url');
}

function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, 32);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored) return true;
  const parts = String(stored).split('$');
  if (parts.length !== 3) return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  let actual;
  try {
    actual = crypto.scryptSync(String(password ?? ''), salt, expected.length);
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** Remove stored binary + metadata for a file id. */
async function removeFile(id) {
  const entry = state.files[id];
  if (!entry) return false;
  delete state.files[id];
  scheduleFlush();
  await fsp.rm(path.join(UPLOAD_DIR, entry.storedName), { force: true }).catch(() => {});
  return true;
}

/** Deletes expired entries and their payloads; returns number removed. */
async function sweepExpired(now = Date.now()) {
  const expired = Object.values(state.files).filter((f) => f.expiresAt && f.expiresAt <= now);
  for (const f of expired) await removeFile(f.id);
  return expired.length;
}

function createEntry({ id, name, size, mime, storedName, password, expiresAt, checksum }) {
  const deleteToken = newToken();
  const entry = {
    id,
    name,
    size,
    mime: mime || 'application/octet-stream',
    storedName,
    checksum: checksum || null,
    passwordHash: password ? hashPassword(password) : null,
    deleteTokenHash: hashPassword(deleteToken),
    createdAt: Date.now(),
    expiresAt: expiresAt || null,
    downloads: 0,
  };
  state.files[id] = entry;
  scheduleFlush();
  return { entry, deleteToken };
}

function incrementDownloads(id) {
  const entry = state.files[id];
  if (!entry) return;
  entry.downloads += 1;
  entry.lastDownloadAt = Date.now();
  scheduleFlush();
}

function get(id) {
  return state.files[id] || null;
}

function list() {
  return Object.values(state.files).sort((a, b) => b.createdAt - a.createdAt);
}

function stats() {
  const values = Object.values(state.files);
  return {
    files: values.length,
    totalBytes: values.reduce((sum, f) => sum + (f.size || 0), 0),
    downloads: values.reduce((sum, f) => sum + (f.downloads || 0), 0),
    freeBytes: freeDiskBytes(),
  };
}

function freeDiskBytes() {
  try {
    const s = fs.statfsSync(DATA_DIR);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

/** Public representation of a file (never leaks hashes or storage paths). */
function toPublic(entry, baseUrl) {
  return {
    id: entry.id,
    name: entry.name,
    size: entry.size,
    mime: entry.mime,
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt,
    downloads: entry.downloads,
    checksum: entry.checksum ? `sha256:${entry.checksum}` : null,
    locked: Boolean(entry.passwordHash),
    downloadUrl: `${baseUrl}/f/${entry.id}`,
    shareUrl: `${baseUrl}/s/${entry.id}`,
  };
}

function verifyDeleteToken(id, token) {
  const entry = state.files[id];
  if (!entry || !token) return false;
  return verifyPassword(token, entry.deleteTokenHash);
}

module.exports = {
  newId,
  newToken,
  createEntry,
  incrementDownloads,
  removeFile,
  sweepExpired,
  get,
  list,
  stats,
  toPublic,
  verifyPassword,
  verifyDeleteToken,
  sha256File,
  hashPassword,
  ready: () => flushing,
  flush,
};

'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Determine the writable data directory.
 * Priority: DATA_DIR env -> persistent disk (/data when mounted) -> ./data
 * Files must survive a redeploy, so a mounted volume is required in production.
 */
function resolveDataDir() {
  const candidates = [];
  if (process.env.DATA_DIR) candidates.push(process.env.DATA_DIR);
  candidates.push('/data', path.join(process.cwd(), 'data'));

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      const uploads = path.join(dir, 'uploads');
      fs.mkdirSync(uploads, { recursive: true });
      return dir;
    } catch {
      /* try next candidate */
    }
  }
  throw new Error('لا يوجد مجلد بيانات قابل للكتابة (DATA_DIR)');
}

const DATA_DIR = resolveDataDir();
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
fs.mkdirSync(TMP_DIR, { recursive: true });

module.exports = {
  DATA_DIR,
  UPLOAD_DIR,
  TMP_DIR,
  META_FILE: path.join(DATA_DIR, 'files.json'),
  PUBLIC_DIR: path.join(__dirname, '..', 'public'),
};

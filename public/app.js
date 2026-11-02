'use strict';

/* ------------------------------------------------------------------ *
 * AppJet Share — client logic (landing page, modal, downloads)
 * ------------------------------------------------------------------ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  builds: [],
  selectedDevice: null,
  baseUrl: location.origin,
  uploading: false,
};

const DEVICE_INFO = {
  android: {
    title: 'تطبيق Android',
    desc: 'ملف APK موقّع رقميًا يمكن تثبيته مباشرة على الهواتف والأجهزة اللوحية التي تعمل بنظام Android.',
    requirements: [
      'Android 7.0 أو أحدث',
      'السماح بتثبيت التطبيقات من مصدر موثوق عند الطلب',
      'اتصال إنترنت للوصول إلى الخادم العالمي',
    ],
    label: 'تحميل APK',
  },
  ios: {
    title: 'تطبيق iPhone',
    desc: 'تثبيت معتمد على iOS عبر Safari (تثبيت من الموقع — Web App معتمد). التطبيق يعمل على iPhone 18 Pro وجميع إصدارات iOS الحديثة، ويمكن تثبيته من متجر App Store إن رغبت بنشر رسمي.',
    requirements: [
      'iOS 16.4 أو أحدث (iPhone 18 Pro مدعوم)',
      'فتح الموقع في متصفح Safari',
      'اضغط «مشاركة» ثم «إضافة إلى الشاشة الرئيسية» للتثبيت',
    ],
    label: 'تثبيت على iPhone',
  },
  windows: {
    title: 'تطبيق Windows',
    desc: 'تطبيق سطح مكتب لـ Windows بصيغة EXE يتصل مباشرة بالخادم العالمي لرفع الملفات وتنزيلها.',
    requirements: [
      'Windows 10 أو Windows 11 (64-bit)',
      'صلاحية تشغيل ملفات EXE غير الموقّعة من Microsoft Store',
      'اتصال إنترنت عبر HTTPS',
    ],
    label: 'تحميل EXE',
  },
};

function toast(message, ms = 2600) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), ms);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} بايت`;
  const units = ['كيلوبايت', 'ميجابايت', 'جيجابايت', 'تيرابايت'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`;
}

function formatDate(ts) {
  if (!ts) return 'بدون انتهاء';
  try {
    return new Intl.DateTimeFormat('ar', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ts));
  } catch {
    return new Date(ts).toLocaleString();
  }
}

function relativeExpiry(expiresAt) {
  if (!expiresAt) return 'بدون انتهاء';
  const diff = expiresAt - Date.now();
  if (diff <= 0) return 'منتهي';
  const hours = Math.round(diff / 3600000);
  if (hours < 24) return `ينتهي بعد ${hours} ساعة`;
  return `ينتهي بعد ${Math.round(hours / 24)} يوم`;
}

/* --------------------------- origin check -------------------------- */
async function checkOrigin() {
  const label = $('#origin-label');
  if (!label) return;
  try {
    const res = await fetch('/api/health', { headers: { accept: 'application/json' } });
    const data = await res.json();
    const secure = location.protocol === 'https:' || data.https;
    const host = location.host;
    label.textContent = secure ? `${host} · HTTPS آمن` : `${host} · غير مشفّر`;
    label.title = `مدة التشغيل: ${Math.round((data.uptimeSeconds || 0) / 60)} دقيقة`;
  } catch {
    label.textContent = 'تعذر الاتصال بالخادم';
  }
}

/* ------------------------------ upload ----------------------------- */
function setupUpload() {
  const form = $('#upload-form');
  if (!form) return;

  const input = $('#file-input');
  const dropzone = $('#dropzone');
  const picked = $('#picked-file');
  const btn = $('#upload-btn');
  const progress = $('#progress');
  const bar = $('#bar-fill');
  const progressText = $('#progress-text');
  const result = $('#result');

  fetch('/api/stats')
    .then((r) => r.json())
    .then((d) => {
      if (d.maxFileBytes) $('#max-size').textContent = formatBytes(d.maxFileBytes);
    })
    .catch(() => {});

  const showPicked = () => {
    const file = input.files?.[0];
    if (file) {
      picked.hidden = false;
      picked.textContent = `${file.name} · ${formatBytes(file.size)}`;
    } else {
      picked.hidden = true;
    }
  };

  input.addEventListener('change', showPicked);

  ['dragenter', 'dragover'].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    }),
  );
  ['dragleave', 'drop'].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
    }),
  );
  dropzone.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    showPicked();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (state.uploading) return;
    const file = input.files?.[0];
    if (!file) {
      toast('اختر ملفًا أولًا');
      return;
    }

    state.uploading = true;
    btn.disabled = true;
    result.hidden = true;
    progress.hidden = false;
    bar.style.width = '0%';
    progressText.textContent = '0%';

    const body = new FormData();
    body.append('file', file);
    body.append('expires', $('#expires').value);
    const password = $('#password').value.trim();
    if (password) body.append('password', password);

    try {
      const data = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/upload');
        xhr.responseType = 'json';
        xhr.upload.addEventListener('progress', (ev) => {
          if (!ev.lengthComputable) return;
          const pct = Math.round((ev.loaded / ev.total) * 100);
          bar.style.width = `${pct}%`;
          progressText.textContent = `${pct}%`;
        });
        xhr.addEventListener('load', () => {
          const payload = xhr.response || {};
          if (xhr.status >= 200 && xhr.status < 300) resolve(payload);
          else reject(new Error(payload.error || `فشل الرفع (${xhr.status})`));
        });
        xhr.addEventListener('error', () => reject(new Error('انقطع الاتصال أثناء الرفع')));
        xhr.send(body);
      });

      bar.style.width = '100%';
      progressText.textContent = '100%';
      $('#result-url').value = data.file.shareUrl;
      $('#open-link').href = data.file.shareUrl;
      $('#result-title').textContent = `${data.file.name} — تم الرفع بنجاح`;
      $('#result-meta').textContent = `${formatBytes(data.file.size)} · ${relativeExpiry(
        data.file.expiresAt,
      )}${data.file.locked ? ' · محمي بكلمة مرور' : ''}`;
      $('#delete-hint').innerHTML = data.deleteToken
        ? `احتفظ برمز الحذف لحذف الملف لاحقًا: <code>${data.deleteToken}</code>`
        : '';
      localStorage.setItem(`delete:${data.file.id}`, data.deleteToken || '');
      result.hidden = false;
      form.reset();
      picked.hidden = true;
      toast('تم إنشاء رابط عالمي للملف');
      loadFiles();
    } catch (err) {
      progress.hidden = true;
      toast(err.message || 'فشل الرفع');
    } finally {
      state.uploading = false;
      btn.disabled = false;
      setTimeout(() => {
        progress.hidden = true;
        bar.style.width = '0%';
      }, 900);
    }
  });

  $('#copy-btn')?.addEventListener('click', async () => {
    const value = $('#result-url').value;
    try {
      await navigator.clipboard.writeText(value);
      toast('تم نسخ الرابط');
    } catch {
      $('#result-url').select();
      document.execCommand('copy');
      toast('تم نسخ الرابط');
    }
  });
}

/* ------------------------------- files ----------------------------- */
async function loadFiles() {
  const grid = $('#files-grid');
  if (!grid) return;
  try {
    const res = await fetch('/api/files?limit=24', { headers: { accept: 'application/json' } });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error();
    if (!data.files.length) {
      grid.innerHTML =
        '<div class="empty">لا توجد ملفات بعد. ارفع أول ملف وستحصل على رابط عالمي فوري.</div>';
      return;
    }
    grid.innerHTML = data.files
      .map((f) => {
        const ext = (f.name.split('.').pop() || 'file').slice(0, 4);
        return `
        <article class="file-card">
          <div class="file-top">
            <span class="file-badge">${escapeHtml(ext)}</span>
            <div style="min-width:0">
              <div class="file-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
              <div class="file-meta">
                <span>${formatBytes(f.size)}</span>
                <span>${f.downloads} تنزيل</span>
                ${f.locked ? '<span>🔒 محمي</span>' : ''}
              </div>
            </div>
          </div>
          <div class="file-meta">
            <span>${relativeExpiry(f.expiresAt)}</span>
            <span>${formatDate(f.createdAt)}</span>
          </div>
          <div class="file-actions">
            <a class="btn btn-ghost" href="${f.shareUrl}">صفحة المشاركة</a>
            <button class="btn btn-primary" type="button" data-copy="${f.shareUrl}">نسخ الرابط</button>
          </div>
        </article>`;
      })
      .join('');

    $$('[data-copy]', grid).forEach((b) =>
      b.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(b.dataset.copy);
          toast('تم نسخ الرابط');
        } catch {
          toast('انسخ الرابط من صفحة المشاركة');
        }
      }),
    );
  } catch {
    grid.innerHTML = '<div class="empty">تعذر تحميل قائمة الملفات.</div>';
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/* --------------------------- download modal ------------------------ */
async function loadBuilds() {
  try {
    const res = await fetch('/api/downloads', { headers: { accept: 'application/json' } });
    const data = await res.json();
    if (Array.isArray(data.builds)) state.builds = data.builds;
    state.baseUrl = data.baseUrl || location.origin;
  } catch {
    state.builds = [];
  }
  state.builds.forEach((b) => {
    const badge = $(`[data-badge="${b.device}"]`);
    if (!badge) return;
    if (b.available) {
      // iOS ships as an install-from-site PWA (no file), so a byte size would read as "0 bytes".
      const size = b.file && b.size ? formatBytes(b.size) : 'تثبيت من الموقع';
      badge.textContent = `${b.version || ''} · ${size}`.trim();
      badge.classList.add('ready');
    } else {
      badge.textContent = 'غير متاح الآن';
    }
  });
  return state.builds;
}

function buildFor(device) {
  return state.builds.find((b) => b.device === device && b.available);
}

function selectDevice(device) {
  state.selectedDevice = device;
  $$('.device').forEach((el) => {
    const on = el.dataset.device === device;
    el.classList.toggle('selected', on);
    el.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  $$('.step-bar li').forEach((li, i) => li.classList.toggle('active', i === 1));

  const info = DEVICE_INFO[device];
  const detail = $('#device-detail');
  if (!info || !detail) return;

  $('#detail-title').textContent = info.title;
  $('#detail-desc').textContent = info.desc;
  $('#detail-req').innerHTML = info.requirements.map((r) => `<li>${escapeHtml(r)}</li>`).join('');

  const link = $('#detail-download');
  const label = $('#detail-download-label');
  const build = buildFor(device);
  const facts = $('#detail-facts');

  if (device === 'ios') {
    link.href = '/app';
    link.removeAttribute('download');
    label.textContent = 'فتح التطبيق للتثبيت';
    facts.innerHTML = `
      <div><dt>آلية التوزيع</dt><dd>Web App معتمد (Safari)</dd></div>
      <div><dt>التوافق</dt><dd>iOS 16.4+ / iPhone 18 Pro</dd></div>
      <div><dt>الخادم</dt><dd>${escapeHtml(state.baseUrl)}</dd></div>`;
  } else if (build) {
    link.href = build.url;
    link.setAttribute('download', build.file);
    label.textContent = info.label;
    facts.innerHTML = `
      <div><dt>اسم الملف</dt><dd>${escapeHtml(build.file)}</dd></div>
      <div><dt>الحجم</dt><dd>${formatBytes(build.size || 0)}</dd></div>
      <div><dt>الإصدار</dt><dd>${escapeHtml(build.version || '1.0.0')}</dd></div>
      <div><dt>SHA-256</dt><dd>${escapeHtml((build.sha256 || '').slice(0, 24))}…</dd></div>`;
  } else {
    link.href = '#';
    label.textContent = 'التحميل غير متاح';
    facts.innerHTML = `<div><dt>الحالة</dt><dd>لم يُبنَ الملف بعد</dd></div>`;
  }

  detail.hidden = false;
  $$('.step-bar li').forEach((li, i) => li.classList.toggle('active', i === 2));
  detail.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function openDownloadModal(preselect) {
  const modal = $('#download-modal');
  if (!modal) {
    location.href = '/download';
    return;
  }
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
  $$('.step-bar li').forEach((li, i) => li.classList.toggle('active', i === 0));
  const target = preselect || detectDevice();
  if (target) selectDevice(target);
  else {
    state.selectedDevice = null;
    $('#device-detail').hidden = true;
    $$('.device').forEach((el) => el.classList.remove('selected'));
    $$('.step-bar li').forEach((li, i) => li.classList.toggle('active', i === 0));
  }
  loadBuilds();
  $('.device', modal)?.focus?.({ preventScroll: true });
}

function detectDevice() {
  const ua = navigator.userAgent;
  if (/android/i.test(ua)) return 'android';
  if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
  if (/windows/i.test(ua)) return 'windows';
  return null;
}

function closeDownloadModal() {
  const modal = $('#download-modal');
  if (!modal) return;
  modal.hidden = true;
  document.body.style.overflow = '';
}

function setupDownloadModal() {
  $$('[data-open-download]').forEach((btn) =>
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      openDownloadModal();
    }),
  );
  $$('[data-close-download]').forEach((el) => el.addEventListener('click', closeDownloadModal));

  $$('.device').forEach((el) => {
    el.addEventListener('click', () => selectDevice(el.dataset.device));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectDevice(el.dataset.device);
      }
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDownloadModal();
  });

  // Explicit user action only: no automatic download anywhere.
  $('#detail-download')?.addEventListener('click', (e) => {
    const href = e.currentTarget.getAttribute('href');
    if (!href || href === '#') {
      e.preventDefault();
      toast('ملف التثبيت غير متاح حاليًا، حاول لاحقًا');
      return;
    }
    toast(state.selectedDevice === 'ios' ? 'اتبع خطوات التثبيت في Safari' : 'يبدأ التنزيل الآن');
  });

  loadBuilds();
}

/* ---------------------------- download page ------------------------ */
function setupDownloadPage() {
  const container = $('#all-downloads');
  if (!container) return;
  loadBuilds().then(() => {
    container.innerHTML = ['android', 'ios', 'windows']
      .map((device) => {
        const info = DEVICE_INFO[device];
        const build = buildFor(device);
        const available = device === 'ios' || Boolean(build);
        const href = device === 'ios' ? '/app' : build?.url || '#';
        const meta =
          device === 'ios'
            ? 'تثبيت من الموقع عبر Safari'
            : build
              ? `${build.file} · ${formatBytes(build.size || 0)}`
              : 'لم يُبنَ الملف بعد';
        return `
        <article class="device">
          <span class="device-icon ${device}" aria-hidden="true">
            ${device === 'android' ? '🤖' : device === 'ios' ? '' : '🪟'}
          </span>
          <div class="device-body">
            <h3>${escapeHtml(info.title)}</h3>
            <p>${escapeHtml(meta)}</p>
          </div>
          <a class="btn ${available ? 'btn-primary' : 'btn-ghost'} btn-sm"
             href="${href}" ${device === 'ios' ? '' : 'download'} ${available ? '' : 'aria-disabled="true"'}>
            ${escapeHtml(info.label)}
          </a>
        </article>`;
      })
      .join('');
  });
}

/* ------------------------------ share page ------------------------- */
function setupSharePage() {
  const root = $('#share-root');
  if (!root) return;
  const id = location.pathname.split('/').pop();

  const render = (file) => {
    const locked = file.locked;
    root.innerHTML = `
      <div class="share-card">
        <div class="share-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
            <path d="M14 3v5h5" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M19 8.5V19a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6.5L19 8.5Z" stroke-linejoin="round"/>
          </svg>
        </div>
        <h1>${escapeHtml(file.name)}</h1>
        <p class="meta">
          <span>${formatBytes(file.size)}</span>
          <span>${file.downloads} تنزيل</span>
          <span>${relativeExpiry(file.expiresAt)}</span>
        </p>
        ${
          locked
            ? `<form class="lock-form" id="lock-form">
                 <p style="margin:0;color:var(--muted);font-size:.86rem">هذا الملف محمي بكلمة مرور أدخلها للتنزيل.</p>
                 <input class="copy-row input" id="lock-pass" type="password" placeholder="كلمة المرور" required />
                 <button class="btn btn-primary" type="submit">فتح وتنزيل</button>
               </form>`
            : `<div class="share-actions">
                 <a class="btn btn-primary" href="${file.downloadUrl}" download>تنزيل الملف</a>
                 <button class="btn btn-ghost" type="button" id="copy-share">نسخ رابط المشاركة</button>
               </div>`
        }
        <p class="hint">رابط عالمي: ${escapeHtml(file.shareUrl)}</p>
      </div>`;

    $('#copy-share')?.addEventListener('click', async () => {
      await navigator.clipboard.writeText(file.shareUrl).catch(() => {});
      toast('تم نسخ الرابط');
    });

    $('#lock-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = $('#lock-pass').value;
      const res = await fetch(`/api/files/${id}/unlock`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        toast(data.error || 'كلمة المرور غير صحيحة');
        return;
      }
      location.href = `${file.downloadUrl}${data.token ? `?t=${data.token}` : ''}`;
    });
  };

  fetch(`/api/files/${encodeURIComponent(id)}`, { headers: { accept: 'application/json' } })
    .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
    .then(({ ok, d }) => {
      if (!ok || !d.ok) {
        root.innerHTML = `<div class="share-card"><div class="error-box">${
          d.error || 'الملف غير موجود أو انتهت صلاحية الرابط.'
        }</div><a class="btn btn-ghost" href="/">العودة للرئيسية</a></div>`;
        return;
      }
      render(d.file);
    })
    .catch(() => {
      root.innerHTML = '<div class="share-card"><div class="error-box">تعذر الاتصال بالخادم.</div></div>';
    });
}

/* ------------------------------- boot ------------------------------ */
document.addEventListener('DOMContentLoaded', () => {
  checkOrigin();
  setupUpload();
  setupDownloadModal();
  setupDownloadPage();
  setupSharePage();
  loadFiles();
  $('#refresh-files')?.addEventListener('click', loadFiles);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
});

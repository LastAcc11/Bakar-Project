// פרסום האתר ל-Firebase Hosting דרך ה-REST API (בלי firebase-tools).
// שימוש: GOOGLE_ACCESS_TOKEN=... node scripts/deploy-hosting.mjs
// ב-GitHub Actions הטוקן מגיע מ-google-github-actions/auth (Workload Identity Federation).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const SITE = process.env.HOSTING_SITE || 'bakar-reports';
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'bakar-project';
const TOKEN = process.env.GOOGLE_ACCESS_TOKEN;
if (!TOKEN) throw new Error('GOOGLE_ACCESS_TOKEN is not set');

const ROOT = new URL('..', import.meta.url).pathname;
// מה שמתפרסם: קבצי האפליקציה בלבד
const INCLUDE = ['index.html', 'manifest.webmanifest', 'sw.js', 'css', 'js', 'vendor', 'icons'];
const API = 'https://firebasehosting.googleapis.com/v1beta1';

async function call(method, url, body, raw) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'X-Goog-User-Project': PROJECT,
      'Content-Type': raw ? 'application/octet-stream' : 'application/json',
    },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

function walk(p) {
  const full = join(ROOT, p);
  if (statSync(full).isDirectory()) return readdirSync(full).flatMap((f) => walk(join(p, f)));
  return [p];
}

const files = {};
const blobs = {};
for (const p of INCLUDE.flatMap(walk)) {
  if (p.split(sep).some((s) => s.startsWith('.'))) continue;
  const gz = gzipSync(readFileSync(join(ROOT, p)), { level: 9 });
  const hash = createHash('sha256').update(gz).digest('hex');
  files[`/${relative(ROOT, join(ROOT, p)).split(sep).join('/')}`] = hash;
  blobs[hash] = gz;
}
console.log(`Deploying ${Object.keys(files).length} files to ${SITE}…`);

const version = await call('POST', `${API}/sites/${SITE}/versions`, {
  config: { headers: [{ glob: '/sw.js', headers: { 'Cache-Control': 'no-cache' } }] },
});
const { uploadRequiredHashes = [], uploadUrl } = await call('POST', `${API}/${version.name}:populateFiles`, { files });
for (const h of uploadRequiredHashes) await call('POST', `${uploadUrl}/${h}`, null, blobs[h]);
console.log(`Uploaded ${uploadRequiredHashes.length} new/changed files`);
await call('PATCH', `${API}/${version.name}?update_mask=status`, { status: 'FINALIZED' });
await call('POST', `${API}/sites/${SITE}/releases?versionName=${encodeURIComponent(version.name)}`, {});
console.log(`Released → https://${SITE}.web.app`);

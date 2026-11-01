#!/usr/bin/env node
// Creates representative MULTI-TENANT synthetic data through the real
// TempWorks API (no direct SQL): two tenants, an agency and users per tenant
// with different roles, employees, uploaded documents and a profile photo.
// Then confirms the source installation works (tenant isolation + file
// download checksums) BEFORE any backup is taken.
//
// Usage: node seed-api.mjs <apiBase> <outJson>
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const [API, OUT] = process.argv.slice(2);
const env = process.env;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const ok = (m) => console.log(`  ✓ ${m}`);

async function call(method, path, token, body, { form } = {}) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(API + path, { method, headers, body: payload });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, raw: text };
}
const must = async (p, what) => {
  const r = await p;
  if (r.status >= 300) fail(`${what}: HTTP ${r.status} ${typeof r.raw === 'string' ? r.raw.slice(0, 300) : ''}`);
  return r.json?.data ?? r.json;
};
async function login(company, email, password) {
  const r = await must(call('POST', '/auth/login-v2', null, { company, email, password }), `login ${email}@${company}`);
  if (!r.accessToken) fail(`no token for ${email}`);
  return r.accessToken;
}
function pdf(label) {
  return Buffer.from(`%PDF-1.4\n% TempWorks DR drill — ${label}\n${randomBytes(600).toString('base64')}\n%%EOF\n`);
}
function png() { // tiny valid PNG (1x1) + random trailer chunk so each is unique
  const base = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
  return Buffer.concat([base, randomBytes(64)]);
}
async function upload(token, file, name, docTypeId, entityId, mime = 'application/pdf', fname = 'file.pdf') {
  const form = new FormData();
  form.append('file', new Blob([file], { type: mime }), fname);
  form.append('name', name); form.append('documentTypeId', docTypeId);
  form.append('entityType', 'EMPLOYEE'); form.append('entityId', entityId);
  return must(call('POST', '/documents/upload', token, undefined, { form }), `upload ${name}`);
}

const out = { tenants: {}, users: {}, employees: [], documents: [], photos: [] };

// ── 1. platform admin ────────────────────────────────────────────────────────
const admin = await login('tempworks', env.ADMIN_EMAIL, env.ADMIN_PASSWORD);
ok('platform admin signed in (login-v2, company "tempworks")');
const roles = await must(call('GET', '/roles', admin), 'list roles');
const roleId = (n) => (roles.find((r) => r.name === n) || fail(`role ${n} missing`)).id;
const docTypes = await must(call('GET', '/settings/document-types', admin), 'list document types');
const dt = (re) => (docTypes.find((d) => re.test(d.name)) || docTypes[0]).id;
const contractType = dt(/contract/i), idType = dt(/passport|id/i);

// ── 2. tenants, agencies, users ──────────────────────────────────────────────
const plan = [
  { slug: 'alpha', name: 'Alpha Staffing s.r.o.', country: 'Slovakia', users: [
    { email: 'hr@alpha.test', role: 'HR Manager', first: 'Hana', last: 'Novak' },
    { email: 'viewer@alpha.test', role: 'Read Only', first: 'Viktor', last: 'Kral' } ] },
  { slug: 'beta', name: 'Beta Recruitment GmbH', country: 'Germany', users: [
    { email: 'hr@beta.test', role: 'HR Manager', first: 'Berta', last: 'Schulz' } ] },
];
for (const t of plan) {
  const tenant = await must(call('POST', '/tenants', admin, { name: t.name, slug: t.slug }), `create tenant ${t.slug}`);
  const agency = await must(call('POST', '/agencies', admin, {
    name: t.name, country: t.country, contactPerson: 'Ops Lead', email: `ops@${t.slug}.test`,
    phone: '+421900000000', tenantId: tenant.id,
  }), `create agency ${t.slug}`);
  out.tenants[t.slug] = { id: tenant.id, agencyId: agency.id, name: t.name };
  for (const u of t.users) {
    const created = await must(call('POST', '/users', admin, {
      email: u.email, password: env.TENANT_USER_PASSWORD, firstName: u.first, lastName: u.last,
      roleId: roleId(u.role), agencyId: agency.id, status: 'ACTIVE',
    }), `create user ${u.email}`);
    out.users[u.email] = { id: created.id, tenant: t.slug, role: u.role };
  }
  ok(`tenant ${t.slug}: tenant + agency + ${t.users.length} user(s) created via API`);
}

// ── 3. tenant users create employees, upload documents + photo ───────────────
const employees = {
  alpha: [
    { firstName: 'Oleksii', lastName: 'Kovalenko', nationality: 'UA', city: 'Bratislava' },
    { firstName: 'Tawanda', lastName: 'Moyo', nationality: 'ZW', city: 'Košice' } ],
  beta: [ { firstName: 'Ingrid', lastName: 'Schmidt', nationality: 'DE', city: 'Berlin' } ],
};
for (const slug of ['alpha', 'beta']) {
  const tok = await login(slug, `hr@${slug}.test`, env.TENANT_USER_PASSWORD);
  for (const [i, e] of employees[slug].entries()) {
    const emp = await must(call('POST', '/employees', tok, {
      ...e, email: `${e.firstName.toLowerCase()}.${slug}@example.test`, phone: `+4219000000${i}${slug.length}`,
      dateOfBirth: '1990-01-15', addressLine1: 'Main 1', country: 'Slovakia', postalCode: '81101',
    }), `create employee ${e.firstName}`);
    out.employees.push({ id: emp.id, number: emp.employeeNumber, tenant: slug, name: `${e.firstName} ${e.lastName}` });
    for (const [label, type] of [['Work Contract', contractType], ['Identity Document', idType]]) {
      const bytes = pdf(`${label} ${e.firstName} ${slug}`);
      const d = await upload(tok, bytes, `${e.firstName} ${label}`, type, emp.id, 'application/pdf', `${label.replace(/ /g, '_')}.pdf`);
      out.documents.push({ id: d.id, tenant: slug, employeeId: emp.id, name: d.name, fileUrl: d.fileUrl, sha256: sha(bytes), bytes: bytes.length });
    }
    if (i === 0) {
      const form = new FormData(); const img = png();
      form.append('photo', new Blob([img], { type: 'image/png' }), 'photo.png');
      const up = await must(call('PATCH', `/employees/${emp.id}/photo`, tok, undefined, { form }), 'upload photo');
      out.photos.push({ employeeId: emp.id, tenant: slug, photoUrl: up.photoUrl, sha256: sha(img) });
    }
  }
  ok(`tenant ${slug}: ${employees[slug].length} employee(s), documents and photo uploaded through the API`);
}

// ── 4. confirm the SOURCE installation works before any backup ───────────────
for (const slug of ['alpha', 'beta']) {
  const tok = await login(slug, `hr@${slug}.test`, env.TENANT_USER_PASSWORD);
  const list = await must(call('GET', '/employees?limit=100', tok), `list employees as ${slug}`);
  const rows = list.data ?? list.items ?? list;
  const mine = out.employees.filter((e) => e.tenant === slug).map((e) => e.id);
  const others = out.employees.filter((e) => e.tenant !== slug).map((e) => e.id);
  const ids = rows.map((r) => r.id);
  if (!mine.every((id) => ids.includes(id))) fail(`${slug} cannot see its own employees`);
  if (others.some((id) => ids.includes(id))) fail(`TENANT LEAK: ${slug} sees another tenant's employee`);
  ok(`source tenant isolation: ${slug} sees its ${mine.length} employee(s) and none of the other tenant's`);
  for (const d of out.documents.filter((x) => x.tenant === slug)) {
    const res = await fetch(`${API}/documents/${d.id}/file`, { headers: { Authorization: `Bearer ${tok}` } });
    const got = sha(Buffer.from(await res.arrayBuffer()));
    if (res.status !== 200 || got !== d.sha256) fail(`source download mismatch for ${d.name} (${res.status})`);
  }
  ok(`source downloads: all ${out.documents.filter((x) => x.tenant === slug).length} ${slug} attachment(s) byte-identical`);
}
{
  // Cross-tenant FILE access on the source, before any backup.
  const tokA = await login('alpha', 'hr@alpha.test', env.TENANT_USER_PASSWORD);
  const betaDoc = out.documents.find((d) => d.tenant === 'beta');
  const r = await fetch(`${API}/documents/${betaDoc.id}/file`, { headers: { Authorization: `Bearer ${tokA}` } });
  if (![403, 404].includes(r.status)) fail(`TENANT LEAK on source: alpha downloaded a beta attachment (HTTP ${r.status})`);
  ok(`source: cross-tenant attachment download denied (HTTP ${r.status})`);
}
writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`source data recorded → ${OUT}  (${out.employees.length} employees, ${out.documents.length} documents, ${out.photos.length} photos)`);

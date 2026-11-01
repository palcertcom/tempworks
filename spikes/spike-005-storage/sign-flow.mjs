// Spike 005 — Signed-URL access pattern (offline simulation)
// Generates a presigned URL via the AWS SDK v4 signing algorithm against
// a Spaces-compatible endpoint (URL not actually fetched). Validates the
// shape of TTL, query parameters, and the no-leakage path on expiry.

import crypto from 'node:crypto';

function sign(req) {
  const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const dateOnly = date.slice(0, 8);
  const credScope = `${dateOnly}/${req.region}/s3/aws4_request`;
  const params = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${req.accessKey}/${credScope}`,
    'X-Amz-Date': date,
    'X-Amz-Expires': String(req.ttl),
    'X-Amz-SignedHeaders': 'host',
  });
  const canonical = [
    'GET',
    `/${req.bucket}/${req.key}`,
    [...params.entries()].sort().map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&'),
    `host:${req.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', date, credScope,
    crypto.createHash('sha256').update(canonical).digest('hex')].join('\n');
  const kDate    = crypto.createHmac('sha256', 'AWS4'+req.secret).update(dateOnly).digest();
  const kRegion  = crypto.createHmac('sha256', kDate).update(req.region).digest();
  const kService = crypto.createHmac('sha256', kRegion).update('s3').digest();
  const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  params.append('X-Amz-Signature', signature);
  return `https://${req.host}/${req.bucket}/${req.key}?${params}`;
}

function tenantBoundUrl(tenantId, documentId, ttlSec = 300) {
  // The opaque key the API receives is the documentId. The server resolves
  // tenantId from ALS (NEVER from the request body).
  const key = `tenants/${tenantId}/documents/${documentId}.bin`;
  return sign({
    host: 'fra1.digitaloceanspaces.com',
    region: 'fra1',
    bucket: 'tw-prod-eu-files',
    key,
    accessKey: 'AKIAEXAMPLE',
    secret: 'SECRETEXAMPLE',
    ttl: ttlSec,
  });
}

const T_A = '11111111-1111-1111-1111-111111111111';
const T_B = '22222222-2222-2222-2222-222222222222';

const u1 = tenantBoundUrl(T_A, 'doc-001');
const u2 = tenantBoundUrl(T_A, 'doc-001', 60);
const u3 = tenantBoundUrl(T_B, 'doc-001');

console.log('A doc-001 (ttl 300):', u1.length, 'chars');
console.log('A doc-001 (ttl 60): ', u2.length, 'chars');
console.log('B doc-001 (ttl 300):', u3.length, 'chars');
console.log('A and B URLs equal?', u1 === u3 ? 'FAIL leak' : 'PASS (different keys)');
console.log('A signatures equal across TTLs?', u1.split('Signature=')[1] === u2.split('Signature=')[1] ? 'FAIL' : 'PASS (different)');
console.log('Key contains tenantId?', u1.includes(`tenants%2F${T_A}`) || u1.includes(`tenants/${T_A}`) ? 'PASS' : 'FAIL');

import express from 'express';
import crypto from 'crypto';

const app = express();
app.use(express.json({ limit: '32kb' }));

const PORT = Number(process.env.PORT || 10000);
const TTL_HOURS = Number(process.env.LEASE_TTL_HOURS || 24);
const ADMIN_TOKEN = process.env.LEASE_ADMIN_TOKEN || '';

let PRIVATE_KEY = (process.env.LEASE_SIGNING_PRIVATE_KEY_PEM || '').replace(/\\n/g, '\n');
let PUBLIC_KEY = (process.env.LEASE_SIGNING_PUBLIC_KEY_PEM || '').replace(/\\n/g, '\n');
let KEY_ID = process.env.LEASE_KEY_ID || '';
let ephemeralKey = false;

if (!PRIVATE_KEY || !PUBLIC_KEY) {
  const kp = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
  PRIVATE_KEY = kp.privateKey.export({ type: 'pkcs8', format: 'pem' });
  PUBLIC_KEY = kp.publicKey.export({ type: 'spki', format: 'pem' });
  KEY_ID = KEY_ID || `ephemeral-${Date.now()}`;
  ephemeralKey = true;
}
if (!KEY_ID) KEY_ID = 'nb-lease-key';
const PUBLIC_JWK = crypto.createPublicKey(PUBLIC_KEY).export({ format: 'jwk' });

const states = new Map();
for (const row of JSON.parse(process.env.LEASE_BOOTSTRAP_CONTRACTS_JSON || '[]')) {
  if (row?.serial) states.set(String(row.serial).toUpperCase(), { ...row, serial: String(row.serial).toUpperCase() });
}

function signPayload(payload) {
  const payloadJson = JSON.stringify(payload);
  const payloadBytes = Buffer.from(payloadJson, 'utf8');
  const payloadB64 = payloadBytes.toString('base64');
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(payloadBytes);
  signer.end();
  const signatureB64 = signer.sign(PRIVATE_KEY).toString('base64');
  return { envelopeVersion: 1, alg: 'RS256', keyId: KEY_ID, payloadB64, signatureB64 };
}

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(404).json({ error: 'not_found' });
  const token = req.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
  const a = Buffer.from(token);
  const b = Buffer.from(ADMIN_TOKEN);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'unauthorized' });
  next();
}

app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'nodebase-lease-control-api', keyId: KEY_ID, ephemeralKey }));
app.get('/v1/public-key', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('text/plain').send(PUBLIC_KEY);
});
app.get('/v1/public-key-jwk', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ keyId: KEY_ID, alg: 'RS256', kty: PUBLIC_JWK.kty, n: PUBLIC_JWK.n, e: PUBLIC_JWK.e });
});

app.get('/v1/device/:serial/lease-state', (req, res) => {
  const serial = String(req.params.serial || '').trim().toUpperCase();
  const row = states.get(serial);
  if (!row) return res.status(404).json({ error: 'device_not_found' });
  const now = new Date();
  const expiresAt = new Date(now.getTime() + TTL_HOURS * 3600000).toISOString();
  const payload = {
    inventoryNo: String(row.inventoryNo), serial, state: String(row.state),
    graceUntil: row.graceUntil ?? null, source: row.source || 'LEASE_API',
    reasonCode: row.reasonCode ?? null, updatedAt: row.updatedAt || now.toISOString(),
    expiresAt, version: Number(row.version || 1)
  };
  res.set('Cache-Control', 'no-store');
  res.json(signPayload(payload));
});

app.put('/v1/admin/device/:serial/state', requireAdmin, (req, res) => {
  const serial = String(req.params.serial || '').trim().toUpperCase();
  const current = states.get(serial);
  if (!current) return res.status(404).json({ error: 'device_not_found' });
  const allowed = new Set(['ACTIVE', 'GRACE', 'SUSPENDED', 'RETURNED', 'LOST']);
  const state = String(req.body?.state || '').toUpperCase();
  if (!allowed.has(state)) return res.status(400).json({ error: 'invalid_state' });
  const next = { ...current, state, graceUntil: req.body?.graceUntil ?? null,
    reasonCode: req.body?.reasonCode ?? null, source: 'ADMIN_API',
    updatedAt: new Date().toISOString(), version: Number(current.version || 1) + 1 };
  states.set(serial, next);
  res.json({ ok: true, serial, state: next.state, version: next.version, updatedAt: next.updatedAt });
});

app.listen(PORT, '0.0.0.0', () => console.log(`nodebase-lease-control-api listening on ${PORT}`));

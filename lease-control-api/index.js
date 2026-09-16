import express from 'express';
import crypto from 'crypto';

const app = express();
app.use(express.json({ limit: '32kb' }));

const PORT = Number(process.env.PORT || 10000);
const KEY_ID = process.env.LEASE_KEY_ID || 'unset';
const PRIVATE_KEY = (process.env.LEASE_SIGNING_PRIVATE_KEY_PEM || '').replace(/\\n/g, '\n');
const ADMIN_TOKEN = process.env.LEASE_ADMIN_TOKEN || '';
const TTL_HOURS = Number(process.env.LEASE_TTL_HOURS || 24);

if (!PRIVATE_KEY) throw new Error('LEASE_SIGNING_PRIVATE_KEY_PEM is required');
if (!ADMIN_TOKEN) throw new Error('LEASE_ADMIN_TOKEN is required');

const states = new Map();
for (const row of JSON.parse(process.env.LEASE_BOOTSTRAP_CONTRACTS_JSON || '[]')) {
  if (row?.serial) states.set(String(row.serial).toUpperCase(), { ...row, serial: String(row.serial).toUpperCase() });
}

function signPayload(payload) {
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = Buffer.from(payloadJson, 'utf8').toString('base64');
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(Buffer.from(payloadB64, 'utf8'));
  signer.end();
  const signatureB64 = signer.sign(PRIVATE_KEY).toString('base64');
  return { envelopeVersion: 1, alg: 'RS256', keyId: KEY_ID, payloadB64, signatureB64 };
}

function requireAdmin(req, res, next) {
  const token = req.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
  const a = Buffer.from(token);
  const b = Buffer.from(ADMIN_TOKEN);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'unauthorized' });
  next();
}

app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'nodebase-lease-control-api', keyId: KEY_ID }));

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

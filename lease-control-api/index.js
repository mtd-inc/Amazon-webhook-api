import express from 'express';
import crypto from 'crypto';
import pg from 'pg';

const { Pool } = pg;
const app = express();
app.use(express.json({ limit: '32kb' }));

const PORT = Number(process.env.PORT || 10000);
const TTL_HOURS = Number(process.env.LEASE_TTL_HOURS || 24);
const ADMIN_TOKEN = process.env.LEASE_ADMIN_TOKEN || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const DATABASE_SSL = String(process.env.DATABASE_SSL || '').toLowerCase() === 'true';

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

const bootstrap = JSON.parse(process.env.LEASE_BOOTSTRAP_CONTRACTS_JSON || '[]');
const memoryStates = new Map();
for (const row of bootstrap) if (row?.serial) memoryStates.set(String(row.serial).toUpperCase(), { ...row, serial: String(row.serial).toUpperCase() });
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, ssl: DATABASE_SSL ? { rejectUnauthorized: false } : undefined }) : null;

async function initStore() {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS lease_device_state (
    serial text PRIMARY KEY, inventory_no text NOT NULL, state text NOT NULL,
    grace_until timestamptz NULL, source text NOT NULL, reason_code text NULL,
    updated_at timestamptz NOT NULL, version bigint NOT NULL DEFAULT 1
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS lease_audit (
    id bigserial PRIMARY KEY, serial text NOT NULL, before_state text NULL,
    after_state text NOT NULL, reason_code text NULL, source text NOT NULL,
    changed_at timestamptz NOT NULL DEFAULT now()
  )`);
  for (const row of bootstrap) {
    if (!row?.serial || !row?.inventoryNo || !row?.state) continue;
    await pool.query(`INSERT INTO lease_device_state(serial,inventory_no,state,grace_until,source,reason_code,updated_at,version)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(serial) DO NOTHING`, [
      String(row.serial).toUpperCase(), String(row.inventoryNo), String(row.state), row.graceUntil || null,
      row.source || 'BOOTSTRAP', row.reasonCode || null, row.updatedAt || new Date().toISOString(), Number(row.version || 1)
    ]);
  }
}

async function getState(serial) {
  if (!pool) return memoryStates.get(serial) || null;
  const q = await pool.query('SELECT * FROM lease_device_state WHERE serial=$1', [serial]);
  if (!q.rows[0]) return null;
  const r = q.rows[0];
  return { serial:r.serial, inventoryNo:r.inventory_no, state:r.state, graceUntil:r.grace_until,
    source:r.source, reasonCode:r.reason_code, updatedAt:r.updated_at, version:Number(r.version) };
}

async function setState(serial, state, graceUntil, reasonCode) {
  const current = await getState(serial);
  if (!current) return null;
  const next = { ...current, state, graceUntil: graceUntil ?? null, reasonCode: reasonCode ?? null,
    source:'ADMIN_API', updatedAt:new Date().toISOString(), version:Number(current.version || 1)+1 };
  if (!pool) { memoryStates.set(serial, next); return next; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE lease_device_state SET state=$2,grace_until=$3,source='ADMIN_API',reason_code=$4,updated_at=$5,version=$6 WHERE serial=$1`,
      [serial,next.state,next.graceUntil,next.reasonCode,next.updatedAt,next.version]);
    await client.query(`INSERT INTO lease_audit(serial,before_state,after_state,reason_code,source) VALUES($1,$2,$3,$4,'ADMIN_API')`,
      [serial,current.state,next.state,next.reasonCode]);
    await client.query('COMMIT');
    return next;
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

function signPayload(payload) {
  const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const signer = crypto.createSign('RSA-SHA256'); signer.update(payloadBytes); signer.end();
  return { envelopeVersion:1, alg:'RS256', keyId:KEY_ID, payloadB64:payloadBytes.toString('base64'), signatureB64:signer.sign(PRIVATE_KEY).toString('base64') };
}
function requireAdmin(req,res,next) {
  if (!ADMIN_TOKEN) return res.status(404).json({error:'not_found'});
  const a=Buffer.from(req.get('authorization')?.replace(/^Bearer\s+/i,'')||''); const b=Buffer.from(ADMIN_TOKEN);
  if(a.length!==b.length||!crypto.timingSafeEqual(a,b)) return res.status(401).json({error:'unauthorized'}); next();
}

app.get('/healthz', (_req,res)=>res.json({ok:true,service:'nodebase-lease-control-api',keyId:KEY_ID,ephemeralKey,storage:pool?'postgres':'memory'}));
app.get('/v1/public-key', (_req,res)=>{res.set('Cache-Control','no-store');res.type('text/plain').send(PUBLIC_KEY);});
app.get('/v1/public-key-jwk', (_req,res)=>{res.set('Cache-Control','no-store');res.json({keyId:KEY_ID,alg:'RS256',kty:PUBLIC_JWK.kty,n:PUBLIC_JWK.n,e:PUBLIC_JWK.e});});
app.get('/v1/device/:serial/lease-state', async(req,res)=>{
  try {
    const serial=String(req.params.serial||'').trim().toUpperCase(); const row=await getState(serial);
    if(!row) return res.status(404).json({error:'device_not_found'});
    const now=new Date(); const expiresAt=new Date(now.getTime()+TTL_HOURS*3600000).toISOString();
    const payload={inventoryNo:String(row.inventoryNo),serial,state:String(row.state),graceUntil:row.graceUntil??null,source:row.source||'LEASE_API',reasonCode:row.reasonCode??null,updatedAt:row.updatedAt||now.toISOString(),expiresAt,version:Number(row.version||1)};
    res.set('Cache-Control','no-store'); res.json(signPayload(payload));
  } catch(e) { console.error(e); res.status(500).json({error:'internal_error'}); }
});
app.put('/v1/admin/device/:serial/state',requireAdmin,async(req,res)=>{
  try {
    const serial=String(req.params.serial||'').trim().toUpperCase(); const allowed=new Set(['ACTIVE','GRACE','SUSPENDED','RETURNED','LOST']);
    const state=String(req.body?.state||'').toUpperCase(); if(!allowed.has(state)) return res.status(400).json({error:'invalid_state'});
    const next=await setState(serial,state,req.body?.graceUntil,req.body?.reasonCode); if(!next) return res.status(404).json({error:'device_not_found'});
    res.json({ok:true,serial,state:next.state,version:next.version,updatedAt:next.updatedAt});
  } catch(e) { console.error(e); res.status(500).json({error:'internal_error'}); }
});

await initStore();
app.listen(PORT,'0.0.0.0',()=>console.log(`nodebase-lease-control-api listening on ${PORT} storage=${pool?'postgres':'memory'}`));

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
const TABLE_PREFIX = String(process.env.LEASE_TABLE_PREFIX || '').replace(/[^A-Za-z0-9_]/g, '');
const STATE_TABLE = `${TABLE_PREFIX}lease_device_state`;
const AUDIT_TABLE = `${TABLE_PREFIX}lease_audit`;
const VALID_STATES = new Set(['ACTIVE', 'GRACE', 'SUSPENDED', 'RETURNED', 'LOST']);
const TRANSITIONS = {
  ACTIVE: new Set(['ACTIVE', 'GRACE', 'SUSPENDED', 'RETURNED', 'LOST']),
  GRACE: new Set(['GRACE', 'ACTIVE', 'SUSPENDED', 'RETURNED', 'LOST']),
  SUSPENDED: new Set(['SUSPENDED', 'ACTIVE', 'RETURNED', 'LOST']),
  RETURNED: new Set(['RETURNED']),
  LOST: new Set(['LOST'])
};

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
const memoryAudit = [];
for (const row of bootstrap) if (row?.serial) memoryStates.set(String(row.serial).toUpperCase(), { ...row, serial: String(row.serial).toUpperCase() });
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, ssl: DATABASE_SSL ? { rejectUnauthorized: false } : undefined }) : null;

function normalizeState(value) {
  return String(value || '').trim().toUpperCase();
}
function normalizeSerial(value) {
  return String(value || '').trim().toUpperCase();
}
function validateGrace(state, graceUntil) {
  if (state !== 'GRACE') return null;
  if (!graceUntil) return 'grace_until_required';
  const t = new Date(graceUntil);
  if (Number.isNaN(t.getTime())) return 'grace_until_invalid';
  if (t <= new Date()) return 'grace_until_must_be_future';
  return null;
}
function actorFrom(req) {
  return String(req.get('x-operator-id') || 'ADMIN_API').slice(0, 128);
}

async function initStore() {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS ${STATE_TABLE} (
    serial text PRIMARY KEY, inventory_no text NOT NULL, state text NOT NULL,
    grace_until timestamptz NULL, source text NOT NULL, reason_code text NULL,
    updated_at timestamptz NOT NULL, version bigint NOT NULL DEFAULT 1
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ${AUDIT_TABLE} (
    id bigserial PRIMARY KEY, serial text NOT NULL, before_state text NULL,
    after_state text NOT NULL, reason_code text NULL, source text NOT NULL,
    actor text NULL, changed_at timestamptz NOT NULL DEFAULT now()
  )`);
  await pool.query(`ALTER TABLE ${AUDIT_TABLE} ADD COLUMN IF NOT EXISTS actor text NULL`);
  for (const row of bootstrap) {
    if (!row?.serial || !row?.inventoryNo || !row?.state) continue;
    await pool.query(`INSERT INTO ${STATE_TABLE}(serial,inventory_no,state,grace_until,source,reason_code,updated_at,version)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(serial) DO NOTHING`, [
      normalizeSerial(row.serial), String(row.inventoryNo), normalizeState(row.state), row.graceUntil || null,
      row.source || 'BOOTSTRAP', row.reasonCode || null, row.updatedAt || new Date().toISOString(), Number(row.version || 1)
    ]);
  }
}

async function getState(serial) {
  if (!pool) return memoryStates.get(serial) || null;
  const q = await pool.query(`SELECT * FROM ${STATE_TABLE} WHERE serial=$1`, [serial]);
  if (!q.rows[0]) return null;
  const r = q.rows[0];
  return { serial:r.serial, inventoryNo:r.inventory_no, state:r.state, graceUntil:r.grace_until,
    source:r.source, reasonCode:r.reason_code, updatedAt:r.updated_at, version:Number(r.version) };
}

async function upsertDevice({ serial, inventoryNo, state, graceUntil, reasonCode, source, actor }) {
  const now = new Date().toISOString();
  const current = await getState(serial);
  if (!current) {
    const next = { serial, inventoryNo, state, graceUntil: graceUntil ?? null, reasonCode: reasonCode ?? null,
      source: source || 'ADMIN_API', updatedAt: now, version: 1 };
    if (!pool) {
      memoryStates.set(serial, next);
      memoryAudit.push({ serial, beforeState:null, afterState:state, reasonCode:next.reasonCode, source:next.source, actor, changedAt:now });
      return next;
    }
    await pool.query(`INSERT INTO ${STATE_TABLE}(serial,inventory_no,state,grace_until,source,reason_code,updated_at,version)
      VALUES($1,$2,$3,$4,$5,$6,$7,1)`, [serial,inventoryNo,state,next.graceUntil,next.source,next.reasonCode,now]);
    await pool.query(`INSERT INTO ${AUDIT_TABLE}(serial,before_state,after_state,reason_code,source,actor) VALUES($1,NULL,$2,$3,$4,$5)`,
      [serial,state,next.reasonCode,next.source,actor]);
    return next;
  }
  if (String(current.inventoryNo) !== String(inventoryNo)) throw new Error('inventory_mismatch');
  return current;
}

async function setState(serial, state, graceUntil, reasonCode, actor) {
  const current = await getState(serial);
  if (!current) return null;
  if (!TRANSITIONS[current.state]?.has(state)) {
    const err = new Error('transition_not_allowed');
    err.beforeState = current.state;
    err.afterState = state;
    throw err;
  }
  if (current.state === state && String(current.graceUntil || '') === String(graceUntil || '') && String(current.reasonCode || '') === String(reasonCode || '')) {
    return { ...current, idempotent: true };
  }
  const next = { ...current, state, graceUntil: graceUntil ?? null, reasonCode: reasonCode ?? null,
    source:'ADMIN_API', updatedAt:new Date().toISOString(), version:Number(current.version || 1)+1 };
  if (!pool) {
    memoryStates.set(serial, next);
    memoryAudit.push({ serial, beforeState:current.state, afterState:state, reasonCode:next.reasonCode, source:'ADMIN_API', actor, changedAt:next.updatedAt });
    return next;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE ${STATE_TABLE} SET state=$2,grace_until=$3,source='ADMIN_API',reason_code=$4,updated_at=$5,version=$6 WHERE serial=$1`,
      [serial,next.state,next.graceUntil,next.reasonCode,next.updatedAt,next.version]);
    await client.query(`INSERT INTO ${AUDIT_TABLE}(serial,before_state,after_state,reason_code,source,actor) VALUES($1,$2,$3,$4,'ADMIN_API',$5)`,
      [serial,current.state,next.state,next.reasonCode,actor]);
    await client.query('COMMIT');
    return next;
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

async function getAudit(serial, limit = 50) {
  if (!pool) return memoryAudit.filter(x => x.serial === serial).slice(-limit).reverse();
  const q = await pool.query(`SELECT id,serial,before_state AS "beforeState",after_state AS "afterState",reason_code AS "reasonCode",source,actor,changed_at AS "changedAt"
    FROM ${AUDIT_TABLE} WHERE serial=$1 ORDER BY id DESC LIMIT $2`, [serial, limit]);
  return q.rows;
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
    const serial=normalizeSerial(req.params.serial); const row=await getState(serial);
    if(!row) return res.status(404).json({error:'device_not_found'});
    const now=new Date(); const expiresAt=new Date(now.getTime()+TTL_HOURS*3600000).toISOString();
    const payload={inventoryNo:String(row.inventoryNo),serial,state:String(row.state),graceUntil:row.graceUntil??null,source:row.source||'LEASE_API',reasonCode:row.reasonCode??null,updatedAt:row.updatedAt||now.toISOString(),expiresAt,version:Number(row.version||1)};
    res.set('Cache-Control','no-store'); res.json(signPayload(payload));
  } catch(e) { console.error(e); res.status(500).json({error:'internal_error'}); }
});

app.post('/v1/admin/device/:serial',requireAdmin,async(req,res)=>{
  try {
    const serial=normalizeSerial(req.params.serial); const inventoryNo=String(req.body?.inventoryNo||'').trim();
    const state=normalizeState(req.body?.state || 'ACTIVE');
    if(!serial || !inventoryNo) return res.status(400).json({error:'serial_and_inventory_required'});
    if(!VALID_STATES.has(state)) return res.status(400).json({error:'invalid_state'});
    const graceError=validateGrace(state,req.body?.graceUntil); if(graceError) return res.status(400).json({error:graceError});
    const row=await upsertDevice({serial,inventoryNo,state,graceUntil:req.body?.graceUntil,reasonCode:req.body?.reasonCode,source:req.body?.source||'ADMIN_API',actor:actorFrom(req)});
    res.json({ok:true,created:Number(row.version)===1,serial:row.serial,inventoryNo:row.inventoryNo,state:row.state,version:row.version});
  } catch(e) {
    if(e.message==='inventory_mismatch') return res.status(409).json({error:'inventory_mismatch'});
    console.error(e); res.status(500).json({error:'internal_error'});
  }
});

app.put('/v1/admin/device/:serial/state',requireAdmin,async(req,res)=>{
  try {
    const serial=normalizeSerial(req.params.serial); const state=normalizeState(req.body?.state);
    if(!VALID_STATES.has(state)) return res.status(400).json({error:'invalid_state'});
    const graceError=validateGrace(state,req.body?.graceUntil); if(graceError) return res.status(400).json({error:graceError});
    const next=await setState(serial,state,req.body?.graceUntil,req.body?.reasonCode,actorFrom(req)); if(!next) return res.status(404).json({error:'device_not_found'});
    res.json({ok:true,serial,state:next.state,version:next.version,updatedAt:next.updatedAt,idempotent:!!next.idempotent});
  } catch(e) {
    if(e.message==='transition_not_allowed') return res.status(409).json({error:'transition_not_allowed',beforeState:e.beforeState,afterState:e.afterState});
    console.error(e); res.status(500).json({error:'internal_error'});
  }
});

app.get('/v1/admin/device/:serial/audit',requireAdmin,async(req,res)=>{
  try {
    const serial=normalizeSerial(req.params.serial); const limit=Math.max(1,Math.min(100,Number(req.query.limit||50)));
    res.json({ok:true,serial,events:await getAudit(serial,limit)});
  } catch(e) { console.error(e); res.status(500).json({error:'internal_error'}); }
});

await initStore();
app.listen(PORT,'0.0.0.0',()=>console.log(`nodebase-lease-control-api listening on ${PORT} storage=${pool?'postgres':'memory'}`));

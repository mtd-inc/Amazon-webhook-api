import fetch from "node-fetch";
import "dotenv/config";

const TAG = "S73_IMAGE_FRESH_AUDIT_ONCE_RESULT";
const MP = "A1VC38T7YXB528";
const SKUS = [
  "7X-725F-2ZML",
  "s73-hs-i5-11g-16gb-ssd512",
  "s73-hs-i5-11g-8gb-ssd256",
  "s73-hs-i5-11g-8gb-ssd512",
  "s73-hs-i5-11g-8gb-ssd1tb",
  "s73-hs-i5-11g-16gb-ssd1tb",
];
const IMAGE_KEYS = [
  "main_product_image_locator",
  "other_product_image_locator_1",
  "other_product_image_locator_2",
  "other_product_image_locator_3",
  "other_product_image_locator_4",
  "other_product_image_locator_5",
  "other_product_image_locator_6",
  "other_product_image_locator_7",
];
function jp(text) {
  try { return text ? JSON.parse(text) : {}; }
  catch { return { rawText: String(text || "").slice(0, 1000) }; }
}

async function ft(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

function cfg() {
  return {
    sellerId: String(process.env.SPAPI_SELLER_ID || "").trim(),
    endpoint: String(process.env.SPAPI_ENDPOINT || "https://sellingpartnerapi-fe.amazon.com").replace(/\/$/, ""),
  };
}

async function token() {
  const r = await ft("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: process.env.REFRESH_TOKEN, client_id: process.env.LWA_CLIENT_ID, client_secret: process.env.LWA_CLIENT_SECRET }),
  });
  const x = jp(await r.text());
  if (!r.ok || !x.access_token) throw new Error(`LWA_${r.status}`);
  return x.access_token;
}

async function getJson(url, accessToken) {
  const r = await ft(url, { headers: { "x-amz-access-token": accessToken, accept: "application/json" } });
  const body = jp(await r.text());
  return { http: r.status, ok: r.ok, body };
}

async function listing(accessToken, sku) {
  const { sellerId, endpoint } = cfg();
  if (!sellerId) throw new Error("Missing SPAPI_SELLER_ID");
  const q = new URLSearchParams({ marketplaceIds: MP, includedData: "summaries,attributes,issues", issueLocale: "ja_JP" });
  return getJson(`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`, accessToken);
}

async function catalog(accessToken, asin) {
  const { endpoint } = cfg();
  const q = new URLSearchParams({ marketplaceIds: MP, includedData: "images,summaries" });
  return getJson(`${endpoint}/catalog/2022-04-01/items/${encodeURIComponent(asin)}?${q}`, accessToken);
}

function gb(entry) {
  if (!entry) return null;
  const n = Number(entry.value);
  const unit = String(entry.unit || "GB").toUpperCase();
  if (!Number.isFinite(n)) return null;
  if (unit === "TB") return n * 1024;
  if (unit === "MB") return n / 1024;
  return n;
}

function nested(attrs, key, subkey) {
  const row = Array.isArray(attrs?.[key]) ? attrs[key][0] : null;
  return row?.[subkey] || null;
}

function imageAttrs(attrs) {
  const out = {};
  for (const key of IMAGE_KEYS) {
    const rows = Array.isArray(attrs?.[key]) ? attrs[key] : [];
    out[key] = rows.map(x => x?.media_location || x?.mediaLocation || x?.value || "").filter(Boolean);
  }
  return out;
}

function issues(body) {
  return (Array.isArray(body?.issues) ? body.issues : []).map(x => ({ code: String(x?.code || ""), severity: String(x?.severity || ""), message: String(x?.message || "").slice(0, 300) }));
}
async function run() {
  const accessToken = await token();
  const children = [];
  for (const sku of SKUS) {
    const li = await listing(accessToken, sku);
    const summary = li.body?.summaries?.[0] || {};
    const attrs = li.body?.attributes || {};
    const asin = String(summary.asin || "");
    const cat = asin ? await catalog(accessToken, asin) : { http: null, body: {} };
    children.push({
      sku, asin, listingHttp: li.http, catalogHttp: cat.http,
      ramGB: gb(nested(attrs, "ram_memory", "installed_size")),
      storageGB: gb(nested(attrs, "hard_disk", "size")) ?? gb(nested(attrs, "flash_memory", "installed_size")),
      listingImages: imageAttrs(attrs),
      catalogImages: Array.isArray(cat.body?.images) ? cat.body.images : [],
      issues: issues(li.body),
    });
  }
  return { status: "S73_IMAGE_FRESH_READ_ONLY", readOnly: true, amazonPersistentWrites: 0, inventoryWrites: 0, priceWrites: 0, b2bWrites: 0, adsWrites: 0, yahooWrites: 0, externalChanges: 0, children };
}

setTimeout(() => run().then(x => console.log(`${TAG}=${JSON.stringify(x)}`)).catch(e => console.error(`${TAG}=${JSON.stringify({ status: "AUDIT_ERROR", error: e?.message || String(e), readOnly: true, externalChanges: 0 })}`)), 8000);

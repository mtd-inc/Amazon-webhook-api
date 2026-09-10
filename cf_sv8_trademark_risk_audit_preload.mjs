import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-09-10-cf-sv8-trademark-risk-audit-v1.0.0";
const TAG = "CF_SV8_TRADEMARK_RISK_AUDIT_RESULT";
const ERR = "CF_SV8_TRADEMARK_RISK_AUDIT_ERROR";
const MARKETPLACE_ID = "A1VC38T7YXB528";
const TARGETS = Object.freeze([
  Object.freeze({ sku: "cf-sv8-i5-8gb-ssd1", asin: "B0GH7CDB3Y" }),
  Object.freeze({ sku: "cf-sv8-i5-8gb-ssd256", asin: "B0GH792325" }),
]);

function cfg() {
  const sellerId = String(process.env.SPAPI_SELLER_ID || "").trim();
  const endpoint = String(process.env.SPAPI_ENDPOINT || "https://sellingpartnerapi-fe.amazon.com").replace(/\/$/, "");
  if (!sellerId) throw new Error("Missing SPAPI_SELLER_ID");
  return { sellerId, endpoint };
}

async function token() {
  const clientId = process.env.LWA_CLIENT_ID;
  const clientSecret = process.env.LWA_CLIENT_SECRET;
  const refreshToken = process.env.REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Missing LWA credentials");
  const r = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error(`LWA ${r.status}`);
  return j.access_token;
}

async function getListing(accessToken, sku) {
  const { sellerId, endpoint } = cfg();
  const q = new URLSearchParams({
    marketplaceIds: MARKETPLACE_ID,
    includedData: "summaries,attributes,issues,offers,fulfillmentAvailability",
    issueLocale: "ja_JP",
  });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`;
  const r = await fetch(url, { headers: { "x-amz-access-token": accessToken, accept: "application/json" } });
  const text = await r.text();
  let body = {};
  try { body = JSON.parse(text); } catch { body = { rawText: text }; }
  if (!r.ok) throw new Error(`GET ${sku} HTTP ${r.status} ${text}`);
  return body;
}

function imageMap(attributes) {
  const out = [];
  const keys = Object.keys(attributes || {}).filter(k => /product_image_locator|media_locator/i.test(k)).sort();
  for (const key of keys) {
    const vals = Array.isArray(attributes[key]) ? attributes[key] : [];
    for (const v of vals) {
      out.push({
        attribute: key,
        url: v?.media_location || v?.value || "",
        marketplaceId: v?.marketplace_id || "",
      });
    }
  }
  return out;
}

function values(attributes, key) {
  return (Array.isArray(attributes?.[key]) ? attributes[key] : []).map(v => v?.value ?? v?.media_location ?? v).filter(v => v !== undefined && v !== null);
}

async function run() {
  const accessToken = await token();
  const results = [];
  for (const target of TARGETS) {
    const x = await getListing(accessToken, target.sku);
    const s = Array.isArray(x?.summaries) ? (x.summaries[0] || {}) : {};
    const a = x?.attributes && typeof x.attributes === "object" ? x.attributes : {};
    const issues = Array.isArray(x?.issues) ? x.issues : [];
    const errors = issues.filter(i => String(i?.severity || "").toUpperCase() === "ERROR");
    results.push({
      sku: target.sku,
      expectedAsin: target.asin,
      asin: s.asin || "",
      asinMatches: (s.asin || "") === target.asin,
      productType: s.productType || "",
      statuses: Array.isArray(s.status) ? s.status : [],
      itemName: s.itemName || "",
      brand: values(a, "brand"),
      manufacturer: values(a, "manufacturer"),
      model: values(a, "model_name").concat(values(a, "model_number")),
      images: imageMap(a),
      imageCount: imageMap(a).length,
      errorCount: errors.length,
      issues,
      fulfillmentAvailability: Array.isArray(x?.fulfillmentAvailability) ? x.fulfillmentAvailability : [],
      offers: Array.isArray(x?.offers) ? x.offers : [],
    });
  }
  console.log(`${TAG}=${JSON.stringify({
    status: "CF_SV8_TRADEMARK_RISK_AUDIT_COMPLETE",
    moduleVersion: MODULE_VERSION,
    readOnly: true,
    marketplaceId: MARKETPLACE_ID,
    results,
    amazonPersistentWrites: 0,
    inventoryWrites: 0,
    priceWrites: 0,
    b2bWrites: 0,
    adsWrites: 0,
    yahooWrites: 0,
    externalChanges: 0,
  })}`);
}

run().catch(e => console.error(`${ERR}=${JSON.stringify({ status: "FAILED", moduleVersion: MODULE_VERSION, readOnly: true, error: e?.message || String(e), amazonPersistentWrites: 0, externalChanges: 0 })}`));

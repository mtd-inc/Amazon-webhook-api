import express from "express";
import fetch from "node-fetch";
import crypto from "node:crypto";
import "dotenv/config";

const VERSION = "AMAZON_RETIRED4_DELETE_PREFLIGHT_V1_0_0";
const ROUTE = "/amazon/listing/retired4-delete-preflight";
const MARKETPLACE_ID = "A1VC38T7YXB528";
const REQUEST_TIMEOUT_MS = 20000;
const REQUEST_GAP_MS = 350;
const originalListen = express.application.listen;

const TARGETS = Object.freeze([
  Object.freeze({ sku: "F7-AF7O-IGX5", asin: "B0FN3KQFR3", productType: "NOTEBOOK_COMPUTER", replacementSku: "g83-hs-i5-11g-8gb-ssd256-r1", replacementAsin: "B0HJ8L6KJY", reason: "G83_REPLACEMENT_RETIRED" }),
  Object.freeze({ sku: "9K-D0RA-4R8V", asin: "B0FPC4R7ZG", productType: "NOTEBOOK_COMPUTER", replacementSku: "g83-hs-i5-11g-8gb-ssd1tb-r1", replacementAsin: "B0HJ8SKQGG", reason: "G83_REPLACEMENT_RETIRED" }),
  Object.freeze({ sku: "cf-sv8-i5-8gb-ssd256", asin: "B0GH792325", productType: "NOTEBOOK_COMPUTER", reason: "CF_SV8_18653_RETIRED" }),
  Object.freeze({ sku: "cf-sv8-i5-8gb-ssd1", asin: "B0GH7CDB3Y", productType: "NOTEBOOK_COMPUTER", reason: "CF_SV8_18653_RETIRED" }),
]);

function safeJsonParse(text) { if (!text) return {}; try { return JSON.parse(text); } catch { return { rawText: text }; } }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function sha256Json(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function auditToken() { return String(process.env.AMAZON_RETIRED4_AUDIT_TOKEN || "").trim(); }
function getConfig() {
  const sellerId = String(process.env.SPAPI_SELLER_ID || "").trim();
  const marketplaceId = String(process.env.SPAPI_MARKETPLACE_ID || MARKETPLACE_ID).trim();
  const endpoint = String(process.env.SPAPI_ENDPOINT || "https://sellingpartnerapi-fe.amazon.com").replace(/\/$/, "");
  if (!sellerId) throw new Error("Missing env: SPAPI_SELLER_ID");
  if (marketplaceId !== MARKETPLACE_ID) throw new Error(`marketplace mismatch: ${marketplaceId}`);
  return { sellerId, marketplaceId, endpoint };
}
async function getLwaAccessToken() {
  const clientId = process.env.LWA_CLIENT_ID;
  const clientSecret = process.env.LWA_CLIENT_SECRET;
  const refreshToken = process.env.REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Missing LWA env");
  const response = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
  });
  const json = safeJsonParse(await response.text());
  if (!response.ok || !json.access_token) throw new Error(`LWA token error: ${response.status}`);
  return json.access_token;
}
async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}
async function getListingRaw(accessToken, sku) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({ marketplaceIds: marketplaceId, issueLocale: "ja_JP", includedData: "summaries,issues,fulfillmentAvailability" });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${query}`;
  const response = await fetchWithTimeout(url, { method: "GET", headers: { "x-amz-access-token": accessToken, accept: "application/json" } });
  const text = await response.text();
  return { httpStatus: response.status, responseOk: response.ok, body: safeJsonParse(text) };
}
function snapshot(result) {
  if (!result?.responseOk) return null;
  const body = result.body || {};
  const summary = Array.isArray(body.summaries) ? body.summaries[0] || {} : {};
  const statuses = Array.isArray(summary.status) ? summary.status.map(x => String(x || "").trim()).filter(Boolean) : [];
  const issues = Array.isArray(body.issues) ? body.issues : [];
  const fulfillment = Array.isArray(body.fulfillmentAvailability) ? body.fulfillmentAvailability : [];
  const availableQuantity = fulfillment.reduce((sum, row) => { const n = Number(row?.quantity); return sum + (Number.isFinite(n) ? Math.max(0, n) : 0); }, 0);
  return {
    sku: String(body.sku || ""),
    asin: String(summary.asin || ""),
    title: String(summary.itemName || ""),
    productType: String(summary.productType || ""),
    statuses,
    buyable: statuses.includes("BUYABLE"),
    discoverable: statuses.includes("DISCOVERABLE"),
    deleted: statuses.includes("DELETED"),
    availableQuantity,
    issueCodes: issues.map(x => String(x?.code || "")).filter(Boolean),
    issueCount: issues.length,
  };
}
async function inspectTarget(accessToken, target) {
  const oldRaw = await getListingRaw(accessToken, target.sku);
  const old = snapshot(oldRaw);
  let replacementRaw = null;
  let replacement = null;
  if (target.replacementSku) {
    await sleep(REQUEST_GAP_MS);
    replacementRaw = await getListingRaw(accessToken, target.replacementSku);
    replacement = snapshot(replacementRaw);
  }
  const alreadyGone = oldRaw.httpStatus === 404 || old?.deleted === true;
  const checks = {
    oldExistsOrAlreadyGone: oldRaw.responseOk || oldRaw.httpStatus === 404,
    oldSkuExact: alreadyGone || old?.sku === target.sku,
    oldAsinExact: alreadyGone || old?.asin === target.asin,
    oldProductTypeExact: alreadyGone || old?.productType === target.productType,
    oldNotBuyable: alreadyGone || old?.buyable === false,
    oldQuantityZero: alreadyGone || old?.availableQuantity === 0,
    replacementGetOk: target.replacementSku ? replacementRaw?.responseOk === true : true,
    replacementSkuExact: target.replacementSku ? replacement?.sku === target.replacementSku : true,
    replacementAsinExact: target.replacementSku ? replacement?.asin === target.replacementAsin : true,
    replacementNotDeleted: target.replacementSku ? replacement?.deleted === false : true,
  };
  return {
    sku: target.sku,
    asin: target.asin,
    reason: target.reason,
    replacementSku: target.replacementSku || null,
    replacementAsin: target.replacementAsin || null,
    oldHttpStatus: oldRaw.httpStatus,
    old,
    replacementHttpStatus: replacementRaw?.httpStatus ?? null,
    replacement,
    alreadyGone,
    checks,
    amazonDeleteReady: Object.values(checks).every(Boolean),
  };
}
async function handler(req, res) {
  try {
    const token = auditToken();
    if (!token) return res.status(503).json({ ok: false, version: VERSION, readOnly: true, externalChanges: 0, error: "AUDIT_DISABLED" });
    if (String(req.headers["x-audit-token"] || "") !== token) return res.status(401).json({ ok: false, version: VERSION, readOnly: true, externalChanges: 0, error: "Unauthorized" });
    const accessToken = await getLwaAccessToken();
    const results = [];
    for (let i = 0; i < TARGETS.length; i += 1) {
      results.push(await inspectTarget(accessToken, TARGETS[i]));
      if (i < TARGETS.length - 1) await sleep(REQUEST_GAP_MS);
    }
    const allAmazonDeleteReady = results.every(x => x.amazonDeleteReady);
    const hashMaterial = results.map(x => ({ sku: x.sku, asin: x.asin, alreadyGone: x.alreadyGone, oldHttpStatus: x.oldHttpStatus, old: x.old, replacementHttpStatus: x.replacementHttpStatus, replacement: x.replacement, checks: x.checks }));
    return res.status(200).json({
      ok: true,
      version: VERSION,
      route: ROUTE,
      readOnly: true,
      externalChanges: 0,
      marketplaceId: MARKETPLACE_ID,
      targetCount: TARGETS.length,
      allAmazonDeleteReady,
      preflightHash: sha256Json(hashMaterial),
      results,
      note: "READ ONLY. This route never DELETEs or PATCHes an Amazon listing.",
    });
  } catch (err) {
    return res.status(500).json({ ok: false, version: VERSION, route: ROUTE, readOnly: true, externalChanges: 0, error: String(err?.message || err) });
  }
}

express.application.listen = function amazonRetired4DeletePreflightListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};

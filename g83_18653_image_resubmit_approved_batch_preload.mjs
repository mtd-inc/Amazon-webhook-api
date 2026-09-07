import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import "dotenv/config";

const MODULE_VERSION = "2026-09-07-g83-18653-approved-batch-live-v1.0.0";
const ROUTE = "/amazon/listing/g83-18653-approved-batch-live";
const MARKETPLACE_ID = "A1VC38T7YXB528";
const PRODUCT_TYPE = "NOTEBOOK_COMPUTER";
const ISSUE_CODE = "18653";
const USER_APPROVAL = "LIVE_APPROVED_20260907";
const REQUEST_TIMEOUT_MS = 20000;
const originalListen = express.application.listen;
let consumed = false;

const EXPECTED_IMAGE_KEYS = Object.freeze([
  "main_product_image_locator",
  "other_product_image_locator_1",
  "other_product_image_locator_2",
  "other_product_image_locator_3",
  "other_product_image_locator_4",
  "other_product_image_locator_5",
  "other_product_image_locator_6",
  "other_product_image_locator_7",
]);

const TARGETS = Object.freeze([
  Object.freeze({
    sku: "F7-AF7O-IGX5",
    asin: "B0FN3KQFR3",
    previewSubmissionId: "02b50e54ae6e45e8bd5ea55bd10f7403",
    previewRequestBodySha256: "871b9b144d34dcc902689d4e2b64ae7a91e26e0a5183d3636f835c7c123bcd7b",
  }),
  Object.freeze({
    sku: "SO-9QJ3-7SHR",
    asin: "B0FPC2JKBY",
    previewSubmissionId: "3cabc328ca7945b5af05a7a76115b88c",
    previewRequestBodySha256: "f77c33f537202b22e1d28ff55885f26f9dd503d863236512851df7d22b8420cf",
  }),
  Object.freeze({
    sku: "9K-D0RA-4R8V",
    asin: "B0FPC4R7ZG",
    previewSubmissionId: "bfd6138ffc6742f78c521a481970629d",
    previewRequestBodySha256: "41155441527d2a3e726db246eee86fbb49247f4a5e67b79c2aa7053090a4008b",
  }),
  Object.freeze({
    sku: "QH-ITJ6-BTTC",
    asin: "B0FPC385LM",
    previewSubmissionId: "ffa837c79ef64134abb4f3fd00c1f337",
    previewRequestBodySha256: "3f517bbd3ca56bd24d94808ae059dfe8e0b244073abf38009cf63b35ed754dc2",
  }),
]);

const FORBIDDEN_PATHS = Object.freeze([
  "/attributes/parentage_level",
  "/attributes/variation_theme",
  "/attributes/child_parent_sku_relationship",
  "/attributes/is_exclusive_product",
  "/attributes/purchasable_offer",
  "/attributes/fulfillment_availability",
]);

function jparse(text) {
  try { return text ? JSON.parse(text) : {}; }
  catch { return { rawText: String(text || "").slice(0, 4000) }; }
}
function clone(v) { return JSON.parse(JSON.stringify(v)); }
function sha256(obj) { return crypto.createHash("sha256").update(JSON.stringify(obj)).digest("hex"); }
function oneTimeSecret() { return String(process.env.G83_18653_ONE_TIME_LIVE_SECRET || "").trim(); }
function cfg() {
  const sellerId = String(process.env.SPAPI_SELLER_ID || "").trim();
  const marketplaceId = String(process.env.SPAPI_MARKETPLACE_ID || MARKETPLACE_ID).trim();
  const endpoint = String(process.env.SPAPI_ENDPOINT || "https://sellingpartnerapi-fe.amazon.com").replace(/\/$/, "");
  if (!sellerId) throw new Error("Missing env: SPAPI_SELLER_ID");
  if (marketplaceId !== MARKETPLACE_ID) throw new Error(`MARKETPLACE_GUARD_BLOCKED ${marketplaceId}`);
  return { sellerId, marketplaceId, endpoint };
}
async function ft(url, opt = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try { return await fetch(url, { ...opt, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}
async function token() {
  const clientId = process.env.LWA_CLIENT_ID;
  const clientSecret = process.env.LWA_CLIENT_SECRET;
  const refreshToken = process.env.REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Missing LWA env");
  const r = await ft("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
  });
  const x = jparse(await r.text());
  if (!r.ok || !x.access_token) throw new Error(`LWA token error ${r.status}`);
  return x.access_token;
}
async function req(url, accessToken, opt = {}) {
  const r = await ft(url, {
    method: opt.method || "GET",
    headers: { "x-amz-access-token": accessToken, accept: "application/json", ...(opt.body ? { "content-type": "application/json" } : {}) },
    ...(opt.body ? { body: JSON.stringify(opt.body) } : {}),
  });
  return { http: r.status, ok: r.ok, body: jparse(await r.text()) };
}
async function getListing(accessToken, sku) {
  const { sellerId, marketplaceId, endpoint } = cfg();
  const q = new URLSearchParams({ marketplaceIds: marketplaceId, includedData: "summaries,attributes,issues", issueLocale: "ja_JP" });
  return req(`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`, accessToken);
}
function isImageKey(key) { return key === "main_product_image_locator" || /^other_product_image_locator_\d+$/.test(key); }
function imageKeys(attrs) {
  return Object.keys(attrs || {}).filter(isImageKey).sort((a, b) => {
    if (a === "main_product_image_locator") return -1;
    if (b === "main_product_image_locator") return 1;
    return Number(a.match(/_(\d+)$/)?.[1] || 999) - Number(b.match(/_(\d+)$/)?.[1] || 999);
  });
}
function issueAttributeNames(issue) {
  const out = [];
  if (Array.isArray(issue?.attributeNames)) out.push(...issue.attributeNames);
  if (issue?.attributeName) out.push(issue.attributeName);
  return [...new Set(out.map(String).filter(Boolean))];
}
function arraysEqual(a, b) { return a.length === b.length && a.every((v, i) => v === b[i]); }

function buildPlan(target, response) {
  const sku = target.sku;
  if (!response.ok) throw new Error(`FRESH_GET_FAILED ${sku} HTTP ${response.http}`);
  const x = response.body || {};
  const summary = Array.isArray(x.summaries) ? x.summaries[0] || {} : {};
  const attrs = x.attributes && typeof x.attributes === "object" ? x.attributes : {};
  const issues = Array.isArray(x.issues) ? x.issues : [];
  if (String(x.sku || "") !== sku) throw new Error(`SKU_MISMATCH ${sku}`);
  if (String(summary.asin || "") !== target.asin) throw new Error(`ASIN_MISMATCH ${sku}`);
  if (String(summary.productType || "") !== PRODUCT_TYPE) throw new Error(`PRODUCT_TYPE_MISMATCH ${sku}`);
  const targetIssues = issues.filter(i => String(i?.code || "") === ISSUE_CODE && String(i?.severity || "").toUpperCase() === "ERROR");
  if (!targetIssues.length) throw new Error(`FRESH_${ISSUE_CODE}_NOT_PRESENT ${sku}; BATCH_LIVE_NOT_SENT`);
  const names = [...new Set(targetIssues.flatMap(issueAttributeNames))];
  const nonImageNames = names.filter(n => !isImageKey(n));
  if (nonImageNames.length) throw new Error(`NON_IMAGE_ISSUE_ATTRIBUTE_BLOCKED ${sku} ${nonImageNames.join(",")}`);
  const keys = imageKeys(attrs);
  if (!arraysEqual(keys, EXPECTED_IMAGE_KEYS)) throw new Error(`IMAGE_KEY_SET_CHANGED ${sku} actual=${JSON.stringify(keys)}`);
  const patches = keys.map(key => {
    const value = attrs[key];
    if (!Array.isArray(value) || !value.length) throw new Error(`IMAGE_ATTRIBUTE_EMPTY ${sku} ${key}`);
    return { op: "replace", path: `/attributes/${key}`, value: clone(value) };
  });
  for (const patch of patches) {
    if (patch.op !== "replace") throw new Error(`NON_REPLACE_PATCH_BLOCKED ${patch.path}`);
    if (!/^\/attributes\/(main_product_image_locator|other_product_image_locator_\d+)$/.test(patch.path)) throw new Error(`NON_IMAGE_PATCH_BLOCKED ${patch.path}`);
    if (FORBIDDEN_PATHS.includes(patch.path)) throw new Error(`FORBIDDEN_PATCH_BLOCKED ${patch.path}`);
  }
  const requestBody = { productType: PRODUCT_TYPE, patches };
  const requestBodySha256 = sha256(requestBody);
  if (requestBodySha256 !== target.previewRequestBodySha256) {
    throw new Error(`FRESH_PAYLOAD_HASH_MISMATCH ${sku} expected=${target.previewRequestBodySha256} actual=${requestBodySha256}; BATCH_LIVE_NOT_SENT`);
  }
  return {
    sku,
    asin: target.asin,
    previewSubmissionId: target.previewSubmissionId,
    requestBodySha256,
    imageKeys: keys,
    patchPaths: patches.map(p => p.path),
    requestBody,
  };
}

async function livePatch(accessToken, plan) {
  const { sellerId, marketplaceId, endpoint } = cfg();
  const q = new URLSearchParams({ marketplaceIds: marketplaceId, issueLocale: "ja_JP", includedData: "issues" });
  const r = await req(`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(plan.sku)}?${q}`, accessToken, {
    method: "PATCH",
    body: plan.requestBody,
  });
  const issues = Array.isArray(r.body?.issues) ? r.body.issues : [];
  const errors = issues.filter(i => String(i?.severity || "").toUpperCase() === "ERROR");
  const status = String(r.body?.status || "").toUpperCase();
  const accepted = r.ok && errors.length === 0 && (status === "ACCEPTED" || status === "VALID");
  return {
    sku: plan.sku,
    asin: plan.asin,
    httpStatus: r.http,
    responseOk: r.ok,
    status,
    submissionId: String(r.body?.submissionId || ""),
    errorCount: errors.length,
    issues,
    accepted,
    requestBodySha256: plan.requestBodySha256,
    patchPaths: plan.patchPaths,
  };
}

async function handler(req, res) {
  let mutationCount = 0;
  try {
    const expectedSecret = oneTimeSecret();
    const providedSecret = String(req.headers["x-g83-one-time-secret"] || "");
    if (!expectedSecret) return res.status(503).json({ ok: false, externalChanges: 0, error: "ONE_TIME_LIVE_SECRET_DISABLED" });
    if (!providedSecret || providedSecret !== expectedSecret) return res.status(401).json({ ok: false, externalChanges: 0, error: "Unauthorized" });
    if (consumed) return res.status(409).json({ ok: false, externalChanges: 0, error: "ONE_TIME_BATCH_ALREADY_CONSUMED" });
    if (String(req.body?.approval || "") !== USER_APPROVAL) throw new Error("USER_LIVE_APPROVAL_TOKEN_MISMATCH");

    const accessToken = await token();

    // Phase 1: preflight ALL 4. No mutation occurs before every target passes.
    const plans = [];
    for (const target of TARGETS) {
      plans.push(buildPlan(target, await getListing(accessToken, target.sku)));
    }

    // Consume before first mutation to block replay on this process.
    consumed = true;

    // Phase 2: execute the exact preview-matched image-only payloads.
    const results = [];
    for (const plan of plans) {
      const result = await livePatch(accessToken, plan);
      if (result.responseOk) mutationCount += 1;
      results.push(result);
      await new Promise(resolve => setTimeout(resolve, 1100));
    }

    const allAccepted = results.every(r => r.accepted === true);
    return res.status(allAccepted ? 200 : 502).json({
      ok: allAccepted,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      approval: USER_APPROVAL,
      preflightPassed4Of4: true,
      exactPreviewHashMatched4Of4: true,
      targetCount: TARGETS.length,
      results,
      amazonPersistentMutationCount: mutationCount,
      variationRelationMutation: 0,
      priceMutation: 0,
      inventoryMutation: 0,
      b2bMutation: 0,
      adsMutation: 0,
      yahooMutation: 0,
      externalChanges: mutationCount,
      note: "Approved one-time LIVE image-only resubmission. 18653 clearance is asynchronous and requires later Fresh audit.",
    });
  } catch (err) {
    console.error("G83 18653 approved batch LIVE error", err?.message || String(err));
    return res.status(400).json({
      ok: false,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      amazonPersistentMutationCount: mutationCount,
      variationRelationMutation: 0,
      priceMutation: 0,
      inventoryMutation: 0,
      b2bMutation: 0,
      adsMutation: 0,
      yahooMutation: 0,
      externalChanges: mutationCount,
      error: err?.message || String(err),
    });
  }
}

express.application.listen = function g8318653ApprovedBatchLiveListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};

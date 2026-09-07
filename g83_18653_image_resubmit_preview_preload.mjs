import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import "dotenv/config";

const MODULE_VERSION = "2026-09-07-g83-18653-image-resubmit-preview-v1.0.0";
const ROUTE = "/amazon/listing/g83-18653-image-resubmit-preview";
const MARKETPLACE_ID = "A1VC38T7YXB528";
const PRODUCT_TYPE = "NOTEBOOK_COMPUTER";
const ISSUE_CODE = "18653";
const REQUEST_TIMEOUT_MS = 20000;
const originalListen = express.application.listen;

const TARGETS = Object.freeze({
  "F7-AF7O-IGX5": "B0FN3KQFR3",
  "SO-9QJ3-7SHR": "B0FPC2JKBY",
  "9K-D0RA-4R8V": "B0FPC4R7ZG",
  "QH-ITJ6-BTTC": "B0FPC385LM",
});

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

function secret() {
  return String(process.env.AMAZON_STOCK_API_SECRET || "").trim();
}

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
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const x = jparse(await r.text());
  if (!r.ok || !x.access_token) throw new Error(`LWA token error ${r.status}`);
  return x.access_token;
}

async function req(url, accessToken, opt = {}) {
  const r = await ft(url, {
    method: opt.method || "GET",
    headers: {
      "x-amz-access-token": accessToken,
      accept: "application/json",
      ...(opt.body ? { "content-type": "application/json" } : {}),
    },
    ...(opt.body ? { body: JSON.stringify(opt.body) } : {}),
  });
  return { http: r.status, ok: r.ok, body: jparse(await r.text()) };
}

async function getListing(accessToken, sku) {
  const { sellerId, marketplaceId, endpoint } = cfg();
  const q = new URLSearchParams({
    marketplaceIds: marketplaceId,
    includedData: "summaries,attributes,issues",
    issueLocale: "ja_JP",
  });
  return req(`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`, accessToken);
}

function isImageKey(key) {
  return key === "main_product_image_locator" || /^other_product_image_locator_\d+$/.test(key);
}

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

function sha256(obj) {
  return crypto.createHash("sha256").update(JSON.stringify(obj)).digest("hex");
}

function inspectFresh(sku, response) {
  if (!response.ok) throw new Error(`FRESH_GET_FAILED ${sku} HTTP ${response.http}`);
  const x = response.body || {};
  const summary = Array.isArray(x.summaries) ? x.summaries[0] || {} : {};
  const attrs = x.attributes && typeof x.attributes === "object" ? x.attributes : {};
  const issues = Array.isArray(x.issues) ? x.issues : [];

  if (String(x.sku || "") !== sku) throw new Error(`SKU_MISMATCH ${sku}`);
  if (String(summary.asin || "") !== TARGETS[sku]) throw new Error(`ASIN_MISMATCH ${sku}`);
  if (String(summary.productType || "") !== PRODUCT_TYPE) throw new Error(`PRODUCT_TYPE_MISMATCH ${sku}`);

  const targetIssues = issues.filter(i => String(i?.code || "") === ISSUE_CODE && String(i?.severity || "").toUpperCase() === "ERROR");
  if (!targetIssues.length) throw new Error(`FRESH_${ISSUE_CODE}_NOT_PRESENT ${sku}; PREVIEW_NOT_SENT`);

  const names = [...new Set(targetIssues.flatMap(issueAttributeNames))];
  const nonImageNames = names.filter(n => !isImageKey(n));
  if (nonImageNames.length) throw new Error(`NON_IMAGE_ISSUE_ATTRIBUTE_BLOCKED ${sku} ${nonImageNames.join(",")}`);

  const keys = imageKeys(attrs);
  if (!keys.length) throw new Error(`NO_IMAGE_ATTRIBUTES ${sku}`);

  const patches = keys.map(key => {
    const value = attrs[key];
    if (!Array.isArray(value) || !value.length) throw new Error(`IMAGE_ATTRIBUTE_EMPTY ${sku} ${key}`);
    return { op: "replace", path: `/attributes/${key}`, value: JSON.parse(JSON.stringify(value)) };
  });

  for (const patch of patches) {
    if (patch.op !== "replace") throw new Error(`NON_REPLACE_PATCH_BLOCKED ${patch.path}`);
    if (!/^\/attributes\/(main_product_image_locator|other_product_image_locator_\d+)$/.test(patch.path)) {
      throw new Error(`NON_IMAGE_PATCH_BLOCKED ${patch.path}`);
    }
    if (FORBIDDEN_PATHS.includes(patch.path)) throw new Error(`FORBIDDEN_PATCH_BLOCKED ${patch.path}`);
  }

  return {
    asin: String(summary.asin || ""),
    productType: String(summary.productType || ""),
    status: Array.isArray(summary.status) ? summary.status : [],
    lastUpdatedDate: x.lastUpdatedDate || null,
    issue18653: targetIssues,
    issueAttributeNames: names,
    imageKeys: keys,
    imageAttributes: Object.fromEntries(keys.map(k => [k, attrs[k]])),
    patches,
  };
}

async function validationPreview(accessToken, sku, patches) {
  const { sellerId, marketplaceId, endpoint } = cfg();
  const q = new URLSearchParams({
    marketplaceIds: marketplaceId,
    issueLocale: "ja_JP",
    includedData: "issues",
    mode: "VALIDATION_PREVIEW",
  });
  const body = { productType: PRODUCT_TYPE, patches };
  const r = await req(`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`, accessToken, { method: "PATCH", body });
  const issues = Array.isArray(r.body?.issues) ? r.body.issues : [];
  const errors = issues.filter(i => String(i?.severity || "").toUpperCase() === "ERROR");
  const status = String(r.body?.status || "").toUpperCase();
  const validationPassed = r.ok && errors.length === 0 && (status === "VALID" || status === "ACCEPTED");
  return {
    httpStatus: r.http,
    responseOk: r.ok,
    status,
    submissionId: String(r.body?.submissionId || ""),
    issues,
    errorCount: errors.length,
    validationPassed,
    raw: r.body,
    requestBody: body,
    requestBodySha256: sha256(body),
  };
}

async function handler(req, res) {
  try {
    const s = secret();
    if (!s) return res.status(500).json({ ok: false, externalChanges: 0, error: "AMAZON_STOCK_API_SECRET is not set" });
    if (String(req.headers["x-api-secret"] || "") !== s) return res.status(401).json({ ok: false, externalChanges: 0, error: "Unauthorized" });

    const sku = String(req.body?.sku || "").trim();
    const dryRun = req.body?.dryRun !== false;
    if (!Object.prototype.hasOwnProperty.call(TARGETS, sku)) throw new Error(`SKU_GUARD_BLOCKED ${sku || "EMPTY"}`);
    if (!dryRun) throw new Error("LIVE is intentionally disabled on this route; dryRun must be true");

    const accessToken = await token();
    const fresh = inspectFresh(sku, await getListing(accessToken, sku));
    const preview = await validationPreview(accessToken, sku, fresh.patches);

    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      sku,
      asin: fresh.asin,
      productType: fresh.productType,
      dryRun: true,
      guard: {
        issueCodeRequired: ISSUE_CODE,
        issuePresent: true,
        imageOnly: true,
        liveDisabled: true,
        variationRelationMutation: false,
        priceMutation: false,
        inventoryMutation: false,
        b2bMutation: false,
        adsMutation: false,
        yahooMutation: false,
      },
      fresh: {
        status: fresh.status,
        lastUpdatedDate: fresh.lastUpdatedDate,
        issue18653: fresh.issue18653,
        issueAttributeNames: fresh.issueAttributeNames,
        imageKeys: fresh.imageKeys,
        imageAttributes: fresh.imageAttributes,
      },
      plannedPatches: fresh.patches.map(p => ({ op: p.op, path: p.path, value: p.value })),
      validationPassed: preview.validationPassed,
      preview: {
        httpStatus: preview.httpStatus,
        responseOk: preview.responseOk,
        status: preview.status,
        submissionId: preview.submissionId,
        errorCount: preview.errorCount,
        issues: preview.issues,
        requestBodySha256: preview.requestBodySha256,
      },
      externalChanges: 0,
      note: "VALIDATION_PREVIEW only. No persistent Amazon listing mutation was executed.",
    });
  } catch (err) {
    console.error("G83 18653 image resubmit preview error", err?.message || String(err));
    return res.status(400).json({
      ok: false,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      externalChanges: 0,
      error: err?.message || String(err),
    });
  }
}

express.application.listen = function g8318653ImageResubmitPreviewListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};

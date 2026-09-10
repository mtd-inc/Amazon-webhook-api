import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import "dotenv/config";

const MODULE_VERSION = "2026-09-10-cf-sv8-100238-pt06-corrected-live-v1.0.0";
const RESULT_TAG = "CF_SV8_100238_PT06_CORRECTED_LIVE_RESULT";
const ERROR_TAG = "CF_SV8_100238_PT06_CORRECTED_LIVE_ERROR";
const REQUEST_TIMEOUT_MS = 20000;
const originalListen = express.application.listen;

const TARGET = Object.freeze({
  sku: "cf-sv8-i5-8gb-ssd512",
  asin: "B0GH7GWDVP",
  productType: "NOTEBOOK_COMPUTER",
  marketplaceId: "A1VC38T7YXB528",
  issueCode: "100238",
  pt: 6,
  attributeName: "other_product_image_locator_6",
  mediaLocation: "https://m.media-amazon.com/images/I/61J1lchKXJL.jpg",
  controlAttributeName: "other_product_image_locator_5",
  controlMediaLocation: "https://m.media-amazon.com/images/I/61SY9FiCT8L.jpg",
  approvedPreviewSubmissionId: "df45a8d1a78c4b158d10178bbaf5a8a5",
  approvedRequestBodySha256: "2327fa425c3bb40cd0de153fa6abd97007b2967a87716e1814e1208153b34c1f",
});

function safeJsonParse(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { rawText: String(text).slice(0, 4000) }; }
}

function getConfig() {
  const sellerId = String(process.env.SPAPI_SELLER_ID || "").trim();
  const marketplaceId = String(process.env.SPAPI_MARKETPLACE_ID || TARGET.marketplaceId).trim();
  const endpoint = String(process.env.SPAPI_ENDPOINT || "https://sellingpartnerapi-fe.amazon.com").replace(/\/$/, "");
  if (!sellerId) throw new Error("CF_SV8_LIVE_GUARD_SPAPI_SELLER_ID_MISSING");
  if (marketplaceId !== TARGET.marketplaceId) throw new Error(`CF_SV8_LIVE_GUARD_MARKETPLACE_MISMATCH:${marketplaceId}`);
  return { sellerId, marketplaceId, endpoint };
}

async function getLwaAccessToken() {
  const clientId = process.env.LWA_CLIENT_ID;
  const clientSecret = process.env.LWA_CLIENT_SECRET;
  const refreshToken = process.env.REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) throw new Error("CF_SV8_LIVE_GUARD_LWA_ENV_MISSING");
  const response = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
  });
  const json = safeJsonParse(await response.text());
  if (!response.ok || !json.access_token) throw new Error(`CF_SV8_LIVE_GUARD_LWA_TOKEN_FAILED:${response.status}`);
  return json.access_token;
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

async function getListing(accessToken) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({ marketplaceIds: marketplaceId, includedData: "summaries,attributes,issues", issueLocale: "ja_JP" });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(TARGET.sku)}?${query}`;
  const response = await fetchWithTimeout(url, { method: "GET", headers: { "x-amz-access-token": accessToken, accept: "application/json" } });
  const json = safeJsonParse(await response.text());
  if (!response.ok) throw new Error(`CF_SV8_LIVE_FRESH_GET_FAILED:${response.status}:${JSON.stringify(json)}`);
  return json;
}

function sha256(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function issueAttributeNames(issue) {
  const names = [];
  if (Array.isArray(issue?.attributeNames)) names.push(...issue.attributeNames.map(String));
  if (issue?.attributeName) names.push(String(issue.attributeName));
  return [...new Set(names.filter(Boolean))];
}

function getSingleMedia(attributes, name) {
  const values = attributes?.[name];
  if (!Array.isArray(values) || values.length !== 1 || !values[0] || typeof values[0] !== "object") {
    throw new Error(`CF_SV8_LIVE_GUARD_ATTRIBUTE_CARDINALITY:${name}`);
  }
  return values[0];
}

function inspectPreLive(listing) {
  const responseSku = String(listing?.sku || "").trim();
  if (responseSku && responseSku !== TARGET.sku) throw new Error(`CF_SV8_LIVE_GUARD_SKU_MISMATCH:${responseSku}`);
  const summary = Array.isArray(listing?.summaries) ? listing.summaries[0] || {} : {};
  const asin = String(summary?.asin || "").trim();
  const productType = String(summary?.productType || "").trim();
  const statuses = Array.isArray(summary?.status) ? summary.status.map(String) : [];
  if (asin !== TARGET.asin) throw new Error(`CF_SV8_LIVE_GUARD_ASIN_MISMATCH:${asin}`);
  if (productType !== TARGET.productType) throw new Error(`CF_SV8_LIVE_GUARD_PRODUCT_TYPE_MISMATCH:${productType}`);
  if (!statuses.includes("BUYABLE") || !statuses.includes("DISCOVERABLE")) throw new Error(`CF_SV8_LIVE_GUARD_STATUS_CHANGED:${JSON.stringify(statuses)}`);

  const issues = Array.isArray(listing?.issues) ? listing.issues : [];
  const errors = issues.filter(x => String(x?.severity || "").toUpperCase() === "ERROR");
  if (errors.length !== 1) throw new Error(`CF_SV8_LIVE_GUARD_ERROR_COUNT_CHANGED:${errors.length}`);
  const issue = errors[0];
  const code = String(issue?.code || "");
  const message = String(issue?.message || "");
  const attributeNames = issueAttributeNames(issue);
  if (code !== TARGET.issueCode || !/PT\s*0*6/i.test(message) || !attributeNames.includes("media_locator")) {
    throw new Error(`CF_SV8_LIVE_GUARD_TARGET_ISSUE_CHANGED:${JSON.stringify({ code, message, attributeNames })}`);
  }

  const attributes = listing?.attributes && typeof listing.attributes === "object" ? listing.attributes : {};
  const targetValue = getSingleMedia(attributes, TARGET.attributeName);
  const targetUrl = String(targetValue?.media_location || "").trim();
  const targetMarketplace = String(targetValue?.marketplace_id || "").trim();
  if (targetUrl !== TARGET.mediaLocation || targetMarketplace !== TARGET.marketplaceId) {
    throw new Error(`CF_SV8_LIVE_GUARD_TARGET_MEDIA_CHANGED:${targetUrl}:${targetMarketplace}`);
  }
  const controlValue = getSingleMedia(attributes, TARGET.controlAttributeName);
  if (String(controlValue?.media_location || "").trim() !== TARGET.controlMediaLocation) {
    throw new Error("CF_SV8_LIVE_GUARD_CONTROL_SLOT_CHANGED");
  }

  return {
    productType,
    statuses,
    deleteValue: [{ media_location: targetUrl, marketplace_id: targetMarketplace }],
    issue: { code, severity: String(issue?.severity || ""), message, attributeNames },
  };
}

function buildBody(productType, deleteValue) {
  return { productType, patches: [{ op: "delete", path: `/attributes/${TARGET.attributeName}`, value: deleteValue }] };
}

async function patch(accessToken, body, validationPreview) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const bodySha256 = sha256(body);
  if (bodySha256 !== TARGET.approvedRequestBodySha256) throw new Error(`CF_SV8_LIVE_GUARD_PAYLOAD_SHA_MISMATCH:${bodySha256}`);
  const query = new URLSearchParams({ marketplaceIds: marketplaceId, issueLocale: "ja_JP", includedData: "issues" });
  if (validationPreview) query.set("mode", "VALIDATION_PREVIEW");
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(TARGET.sku)}?${query}`;
  const response = await fetchWithTimeout(url, {
    method: "PATCH",
    headers: { "x-amz-access-token": accessToken, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const json = safeJsonParse(await response.text());
  const issues = Array.isArray(json?.issues) ? json.issues : [];
  const errors = issues.filter(x => String(x?.severity || "").toUpperCase() === "ERROR");
  const warnings = issues.filter(x => String(x?.severity || "").toUpperCase() === "WARNING");
  const status = String(json?.status || "").toUpperCase();
  return {
    httpStatus: response.status,
    responseOk: response.ok,
    status,
    submissionId: String(json?.submissionId || ""),
    issues,
    errorCount: errors.length,
    warningCount: warnings.length,
    accepted: response.ok && errors.length === 0 && (status === "VALID" || status === "ACCEPTED"),
    bodySha256,
  };
}

function inspectPostLive(listing) {
  const summary = Array.isArray(listing?.summaries) ? listing.summaries[0] || {} : {};
  const statuses = Array.isArray(summary?.status) ? summary.status.map(String) : [];
  const asin = String(summary?.asin || "").trim();
  const issues = Array.isArray(listing?.issues) ? listing.issues : [];
  const errors = issues.filter(x => String(x?.severity || "").toUpperCase() === "ERROR");
  const code100238 = errors.some(x => String(x?.code || "") === TARGET.issueCode);
  const attributes = listing?.attributes && typeof listing.attributes === "object" ? listing.attributes : {};
  const targetSlotPresent = Array.isArray(attributes?.[TARGET.attributeName]) && attributes[TARGET.attributeName].length > 0;
  return {
    asin,
    statuses,
    buyable: statuses.includes("BUYABLE"),
    discoverable: statuses.includes("DISCOVERABLE"),
    errorCount: errors.length,
    issue100238Present: code100238,
    targetSlotPresent,
    targetSlotUrl: String(attributes?.[TARGET.attributeName]?.[0]?.media_location || ""),
    errors: errors.map(x => ({ code: String(x?.code || ""), severity: String(x?.severity || ""), message: String(x?.message || "") })),
  };
}

async function runLiveRepair() {
  let amazonPersistentWrites = 0;
  const accessToken = await getLwaAccessToken();

  const before = inspectPreLive(await getListing(accessToken));
  const body = buildBody(before.productType, before.deleteValue);
  const bodySha256 = sha256(body);
  if (bodySha256 !== TARGET.approvedRequestBodySha256) throw new Error(`CF_SV8_LIVE_GUARD_APPROVED_SHA_MISMATCH:${bodySha256}`);

  const preview = await patch(accessToken, body, true);
  if (!preview.accepted) throw new Error(`CF_SV8_LIVE_GUARD_FRESH_PREVIEW_FAILED:${JSON.stringify(preview)}`);

  const beforeLive = inspectPreLive(await getListing(accessToken));
  const liveBody = buildBody(beforeLive.productType, beforeLive.deleteValue);
  if (sha256(liveBody) !== TARGET.approvedRequestBodySha256) throw new Error("CF_SV8_LIVE_GUARD_FRESH_SHA_CHANGED");

  const live = await patch(accessToken, liveBody, false);
  if (!live.responseOk || !live.accepted) throw new Error(`CF_SV8_LIVE_PATCH_NOT_ACCEPTED:${JSON.stringify(live)}`);
  amazonPersistentWrites = 1;

  const verification = [];
  let final = null;
  for (const delay of [2500, 5000, 10000, 15000, 20000]) {
    await sleep(delay);
    final = inspectPostLive(await getListing(accessToken));
    verification.push(final);
    if (final.asin === TARGET.asin && final.buyable && final.discoverable && final.errorCount === 0 && !final.issue100238Present && !final.targetSlotPresent) break;
  }

  const verified = Boolean(final && final.asin === TARGET.asin && final.buyable && final.discoverable && final.errorCount === 0 && !final.issue100238Present && !final.targetSlotPresent);
  return {
    status: verified ? "CF_SV8_100238_PT06_LIVE_VERIFIED_PASS" : "CF_SV8_100238_PT06_LIVE_ACCEPTED_PROPAGATION_PENDING",
    moduleVersion: MODULE_VERSION,
    sellerSku: TARGET.sku,
    asin: TARGET.asin,
    productType: TARGET.productType,
    issueCode: TARGET.issueCode,
    pt: TARGET.pt,
    attributeName: TARGET.attributeName,
    mediaLocation: TARGET.mediaLocation,
    approvedPreviewSubmissionId: TARGET.approvedPreviewSubmissionId,
    approvedRequestBodySha256: TARGET.approvedRequestBodySha256,
    preLive: { statuses: before.statuses, issue: before.issue },
    freshValidationPreview: preview,
    live,
    verificationAttempts: verification.length,
    finalFresh: final,
    verified,
    amazonPersistentWrites,
    priceMutation: 0,
    inventoryMutation: 0,
    b2bMutation: 0,
    amazonAdsMutation: 0,
    yahooMutation: 0,
    variationRelationMutation: 0,
    otherContentMutation: 0,
    externalChanges: amazonPersistentWrites,
  };
}

let started = false;
express.application.listen = function cfSv8100238Pt06CorrectedLiveListen(...args) {
  const server = originalListen.apply(this, args);
  if (!started) {
    started = true;
    setTimeout(async () => {
      try {
        console.log(`${RESULT_TAG}=${JSON.stringify(await runLiveRepair())}`);
      } catch (error) {
        console.error(`${ERROR_TAG}=${JSON.stringify({
          moduleVersion: MODULE_VERSION,
          sellerSku: TARGET.sku,
          asin: TARGET.asin,
          approvedPreviewSubmissionId: TARGET.approvedPreviewSubmissionId,
          approvedRequestBodySha256: TARGET.approvedRequestBodySha256,
          error: error?.message || String(error),
          amazonPersistentWrites: 0,
          priceMutation: 0,
          inventoryMutation: 0,
          b2bMutation: 0,
          amazonAdsMutation: 0,
          yahooMutation: 0,
          variationRelationMutation: 0,
          otherContentMutation: 0,
          externalChanges: 0,
        })}`);
      }
    }, 2200);
  }
  return server;
};

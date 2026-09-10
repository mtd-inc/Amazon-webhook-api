import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import "dotenv/config";

const MODULE_VERSION = "2026-09-10-cf-sv8-100238-pt06-live-v1.0.0";
const ROUTE = "/amazon/listing/image-suppression-repair-live";
const REQUEST_TIMEOUT_MS = 20000;
const originalListen = express.application.listen;

const LIVE_GUARD = Object.freeze({
  sku: "cf-sv8-i5-8gb-ssd512",
  asin: "B0GH7GWDVP",
  productType: "NOTEBOOK_COMPUTER",
  issueCode: "100238",
  pt: 6,
  attributeName: "other_product_image_locator_5",
  mediaLocation: "https://m.media-amazon.com/images/I/61SY9FiCT8L.jpg",
  previewBodySha256: "d41f75171a2fb8a12a056f6b7792a0abc48b8b25ebc9430221edfb1df04cee14",
  confirmToken: "CONFIRM_CF_SV8_PT06_DELETE_20260910",
});

function safeJsonParse(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { rawText: text }; }
}

function getSecret() {
  return String(process.env.AMAZON_STOCK_API_SECRET || "").trim();
}

function getConfig() {
  const sellerId = String(process.env.SPAPI_SELLER_ID || "").trim();
  const marketplaceId = String(process.env.SPAPI_MARKETPLACE_ID || "A1VC38T7YXB528").trim();
  const endpoint = String(process.env.SPAPI_ENDPOINT || "https://sellingpartnerapi-fe.amazon.com").replace(/\/$/, "");
  if (!sellerId) throw new Error("Missing env: SPAPI_SELLER_ID");
  if (marketplaceId !== "A1VC38T7YXB528") throw new Error(`LIVE_GUARD_BLOCKED: marketplace mismatch ${marketplaceId}`);
  return { sellerId, marketplaceId, endpoint };
}

async function getLwaAccessToken() {
  const clientId = process.env.LWA_CLIENT_ID;
  const clientSecret = process.env.LWA_CLIENT_SECRET;
  const refreshToken = process.env.REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Missing env: LWA_CLIENT_ID / LWA_CLIENT_SECRET / REFRESH_TOKEN");
  }
  const response = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const json = safeJsonParse(await response.text());
  if (!response.ok || !json.access_token) throw new Error(`LWA token error: ${response.status}`);
  return json.access_token;
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getListing(accessToken, sku) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    includedData: "summaries,attributes,issues",
    issueLocale: "ja_JP",
  });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${query}`;
  const response = await fetchWithTimeout(url, {
    method: "GET",
    headers: { "x-amz-access-token": accessToken, accept: "application/json" },
  });
  const json = safeJsonParse(await response.text());
  if (!response.ok) throw new Error(`SP-API GET error: ${response.status} ${JSON.stringify(json)}`);
  return json;
}

function resolveGuardedDelete(listing) {
  const summaries = Array.isArray(listing?.summaries) ? listing.summaries : [];
  const summary = summaries[0] || {};
  const asin = String(summary?.asin || "").trim();
  const productType = String(summary?.productType || "").trim();
  const statuses = Array.isArray(summary?.status) ? summary.status.map(String) : [];

  if (asin !== LIVE_GUARD.asin) throw new Error(`LIVE_GUARD_BLOCKED: ASIN mismatch ${asin}`);
  if (productType !== LIVE_GUARD.productType) throw new Error(`LIVE_GUARD_BLOCKED: productType mismatch ${productType}`);
  if (!statuses.includes("BUYABLE") || !statuses.includes("DISCOVERABLE")) {
    throw new Error(`LIVE_GUARD_BLOCKED: listing status changed ${JSON.stringify(statuses)}`);
  }

  const issues = Array.isArray(listing?.issues) ? listing.issues : [];
  const errors = issues.filter(item => String(item?.severity || "").toUpperCase() === "ERROR");
  if (errors.length !== 1) throw new Error(`LIVE_GUARD_BLOCKED: expected exactly one ERROR, got ${errors.length}`);

  const issue = errors[0];
  const code = String(issue?.code || "");
  const message = String(issue?.message || "");
  const attributeNames = Array.isArray(issue?.attributeNames) ? issue.attributeNames.map(String) : [];
  if (code !== LIVE_GUARD.issueCode || !/PT\s*0*6/i.test(message) || !attributeNames.includes("media_locator")) {
    throw new Error(`LIVE_GUARD_BLOCKED: target issue changed ${JSON.stringify({ code, message, attributeNames })}`);
  }

  const values = listing?.attributes?.[LIVE_GUARD.attributeName];
  if (!Array.isArray(values) || values.length !== 1) {
    throw new Error("LIVE_GUARD_BLOCKED: target attribute must contain exactly one value");
  }
  const media = String(values[0]?.media_location || "").trim();
  if (media !== LIVE_GUARD.mediaLocation) {
    throw new Error(`LIVE_GUARD_BLOCKED: media URL mismatch ${media}`);
  }

  return { productType, value: values, issueMessage: message, statuses };
}

function buildBody(productType, value) {
  return {
    productType,
    patches: [{
      op: "delete",
      path: `/attributes/${LIVE_GUARD.attributeName}`,
      value,
    }],
  };
}

function sha256(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function patchDelete(accessToken, sku, productType, value, validationPreview) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    issueLocale: "ja_JP",
    includedData: "issues",
  });
  if (validationPreview) query.set("mode", "VALIDATION_PREVIEW");

  const body = buildBody(productType, value);
  const bodySha256 = sha256(body);
  if (bodySha256 !== LIVE_GUARD.previewBodySha256) {
    throw new Error(`LIVE_GUARD_BLOCKED: payload SHA mismatch ${bodySha256}`);
  }

  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${query}`;
  const response = await fetchWithTimeout(url, {
    method: "PATCH",
    headers: {
      "x-amz-access-token": accessToken,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  const json = safeJsonParse(await response.text());
  const issues = Array.isArray(json?.issues) ? json.issues : [];
  const errorIssues = issues.filter(x => String(x?.severity || "").toUpperCase() === "ERROR");
  const status = String(json?.status || "").toUpperCase();
  return {
    httpStatus: response.status,
    responseOk: response.ok,
    status,
    submissionId: String(json?.submissionId || ""),
    issues,
    errorCount: errorIssues.length,
    valid: response.ok && errorIssues.length === 0 && (status === "VALID" || status === "ACCEPTED"),
    bodySha256,
    raw: json,
  };
}

async function handler(req, res) {
  let amazonPersistentWrites = 0;
  try {
    const secret = getSecret();
    if (!secret) return res.status(500).json({ ok: false, amazonPersistentWrites: 0, externalChanges: 0, error: "AMAZON_STOCK_API_SECRET is not set" });
    if (String(req.headers["x-api-secret"] || "") !== secret) {
      return res.status(401).json({ ok: false, amazonPersistentWrites: 0, externalChanges: 0, error: "Unauthorized" });
    }

    const sku = String(req.body?.sku || "").trim();
    const confirmToken = String(req.body?.confirmToken || "").trim();
    const expectedPreviewSha256 = String(req.body?.expectedPreviewSha256 || "").trim();
    if (sku !== LIVE_GUARD.sku) throw new Error("LIVE_GUARD_BLOCKED: unexpected SKU");
    if (confirmToken !== LIVE_GUARD.confirmToken) throw new Error("LIVE_GUARD_BLOCKED: confirmation token mismatch");
    if (expectedPreviewSha256 !== LIVE_GUARD.previewBodySha256) throw new Error("LIVE_GUARD_BLOCKED: expected preview SHA mismatch");

    const accessToken = await getLwaAccessToken();
    const listing = await getListing(accessToken, sku);
    const target = resolveGuardedDelete(listing);

    const preview = await patchDelete(accessToken, sku, target.productType, target.value, true);
    if (!preview.valid) {
      throw new Error(`LIVE_GUARD_BLOCKED: fresh validation preview failed ${JSON.stringify(preview.raw)}`);
    }

    // Re-read immediately before LIVE so a changed issue/image cannot pass on stale state.
    const listingFresh = await getListing(accessToken, sku);
    const targetFresh = resolveGuardedDelete(listingFresh);
    const freshBodySha256 = sha256(buildBody(targetFresh.productType, targetFresh.value));
    if (freshBodySha256 !== LIVE_GUARD.previewBodySha256) {
      throw new Error(`LIVE_GUARD_BLOCKED: fresh payload SHA mismatch ${freshBodySha256}`);
    }

    const live = await patchDelete(accessToken, sku, targetFresh.productType, targetFresh.value, false);
    amazonPersistentWrites = 1;

    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      sku,
      asin: LIVE_GUARD.asin,
      productType: LIVE_GUARD.productType,
      issueCode: LIVE_GUARD.issueCode,
      pt: LIVE_GUARD.pt,
      attributeName: LIVE_GUARD.attributeName,
      mediaLocation: LIVE_GUARD.mediaLocation,
      previewBodySha256: LIVE_GUARD.previewBodySha256,
      preflightValidationPassed: true,
      preview: {
        httpStatus: preview.httpStatus,
        status: preview.status,
        submissionId: preview.submissionId,
        errorCount: preview.errorCount,
        issues: preview.issues,
        bodySha256: preview.bodySha256,
      },
      live: {
        httpStatus: live.httpStatus,
        responseOk: live.responseOk,
        status: live.status,
        submissionId: live.submissionId,
        errorCount: live.errorCount,
        issues: live.issues,
        bodySha256: live.bodySha256,
        accepted: Boolean(live.responseOk && live.valid),
      },
      amazonPersistentWrites,
      inventoryWrites: 0,
      priceWrites: 0,
      b2bWrites: 0,
      adsWrites: 0,
      yahooWrites: 0,
      variationRelationWrites: 0,
      externalChanges: amazonPersistentWrites,
      note: "Exactly one guarded PT06 attribute delete may be sent. No inventory/price/B2B/Ads/Yahoo/variation mutation is implemented here.",
    });
  } catch (err) {
    console.error("Amazon image suppression live repair error", err?.message || String(err));
    return res.status(400).json({
      ok: false,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      amazonPersistentWrites,
      inventoryWrites: 0,
      priceWrites: 0,
      b2bWrites: 0,
      adsWrites: 0,
      yahooWrites: 0,
      variationRelationWrites: 0,
      externalChanges: amazonPersistentWrites,
      error: err?.message || String(err),
    });
  }
}

express.application.listen = function amazonImageSuppressionLiveListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};

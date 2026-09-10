import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import "dotenv/config";

const MODULE_VERSION = "2026-09-10-amazon-image-suppression-preview-v1.1.0";
const ROUTE = "/amazon/listing/image-suppression-repair-preview";
const REQUEST_TIMEOUT_MS = 20000;
const originalListen = express.application.listen;

const CF_SV8_AUTORUN = Object.freeze({
  sku: "cf-sv8-i5-8gb-ssd512",
  asin: "B0GH7GWDVP",
  issueCode: "100238",
  pt: 6,
  attributeName: "other_product_image_locator_5",
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
  if (!response.ok || !json.access_token) {
    throw new Error(`LWA token error: ${response.status}`);
  }
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

async function getCatalog(accessToken, asin) {
  const { marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    includedData: "images,summaries,productTypes",
  });
  const url = `${endpoint}/catalog/2022-04-01/items/${encodeURIComponent(asin)}?${query}`;
  const response = await fetchWithTimeout(url, {
    method: "GET",
    headers: { "x-amz-access-token": accessToken, accept: "application/json" },
  });
  const json = safeJsonParse(await response.text());
  return { httpStatus: response.status, ok: response.ok, body: json };
}

function imageAttributeFromPt(pt) {
  if (!Number.isInteger(pt) || pt < 1) return "";
  if (pt === 1) return "main_product_image_locator";
  return `other_product_image_locator_${pt - 1}`;
}

function buildDeletePlan(listing) {
  const issues = Array.isArray(listing?.issues) ? listing.issues : [];
  const attributes = listing?.attributes && typeof listing.attributes === "object" ? listing.attributes : {};
  const targetIssues = issues.filter(issue => {
    return String(issue?.code || "") === "100238" &&
      String(issue?.severity || "").toUpperCase() === "ERROR";
  });

  if (!targetIssues.length) {
    throw new Error("Target image issue 100238 ERROR is not currently present; no preview sent");
  }

  const seen = new Set();
  const plannedDeletes = [];

  for (const issue of targetIssues) {
    const message = String(issue?.message || "");
    const match = message.match(/PT\s*0*(\d+)/i);
    if (!match) throw new Error(`PT number could not be resolved from issue message: ${message}`);

    const pt = Number(match[1]);
    if (pt === 1) {
      throw new Error("MAIN image deletion is not supported by this guarded preview route");
    }

    const attributeName = imageAttributeFromPt(pt);
    if (!attributeName) throw new Error(`Unsupported PT number: ${pt}`);
    if (seen.has(attributeName)) continue;
    seen.add(attributeName);

    const currentValue = attributes[attributeName];
    if (!Array.isArray(currentValue) || currentValue.length === 0) {
      throw new Error(`Current attribute value missing: ${attributeName}`);
    }

    plannedDeletes.push({
      pt,
      issueCode: String(issue?.code || ""),
      message,
      attributeName,
      path: `/attributes/${attributeName}`,
      value: currentValue,
    });
  }

  return plannedDeletes;
}

function buildPreviewBody(productType, plannedDeletes) {
  return {
    productType,
    patches: plannedDeletes.map(item => ({
      op: "delete",
      path: item.path,
      value: item.value,
    })),
  };
}

function sha256(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function validationPreview(accessToken, sku, productType, plannedDeletes) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    issueLocale: "ja_JP",
    includedData: "issues",
    mode: "VALIDATION_PREVIEW",
  });

  const body = buildPreviewBody(productType, plannedDeletes);

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
  const errors = issues.filter(issue => String(issue?.severity || "").toUpperCase() === "ERROR");
  const status = String(json?.status || "").toUpperCase();
  const validationPassed = response.ok && errors.length === 0 && (status === "VALID" || status === "ACCEPTED");

  return {
    httpStatus: response.status,
    responseOk: response.ok,
    status,
    submissionId: String(json?.submissionId || ""),
    issues,
    errorCount: errors.length,
    validationPassed,
    requestBodySha256: sha256(body),
    raw: json,
  };
}

function listingImageSnapshot(listing) {
  const attributes = listing?.attributes && typeof listing.attributes === "object" ? listing.attributes : {};
  return Object.keys(attributes)
    .filter(name => /product_image_locator/i.test(name))
    .sort()
    .map(attributeName => ({
      attributeName,
      values: Array.isArray(attributes[attributeName]) ? attributes[attributeName] : [],
    }));
}

function catalogImageSnapshot(catalogBody) {
  const out = [];
  const groups = Array.isArray(catalogBody?.images) ? catalogBody.images : [];
  for (const group of groups) {
    const images = Array.isArray(group?.images) ? group.images : [];
    for (const image of images) {
      out.push({
        marketplaceId: String(group?.marketplaceId || ""),
        variant: String(image?.variant || ""),
        link: String(image?.link || ""),
        height: image?.height ?? null,
        width: image?.width ?? null,
      });
    }
  }
  return out;
}

async function runCfSv8Autorun() {
  const accessToken = await getLwaAccessToken();
  const listing = await getListing(accessToken, CF_SV8_AUTORUN.sku);
  const summary = Array.isArray(listing?.summaries) ? listing.summaries[0] || {} : {};
  const asin = String(summary?.asin || "").trim();
  const productType = String(summary?.productType || "").trim();
  const status = Array.isArray(summary?.status) ? summary.status.map(String) : [];
  const issues = Array.isArray(listing?.issues) ? listing.issues : [];
  const errorIssues = issues.filter(issue => String(issue?.severity || "").toUpperCase() === "ERROR");

  if (asin !== CF_SV8_AUTORUN.asin) throw new Error(`CF_SV8_GUARD_ASIN_MISMATCH:${asin}`);
  if (!productType) throw new Error("CF_SV8_GUARD_PRODUCT_TYPE_MISSING");

  const targetIssue = errorIssues.find(issue =>
    String(issue?.code || "") === CF_SV8_AUTORUN.issueCode &&
    /PT\s*0*6/i.test(String(issue?.message || ""))
  );
  if (!targetIssue) throw new Error("CF_SV8_GUARD_PT06_100238_NOT_FOUND");

  const plannedDeletes = buildDeletePlan(listing);
  if (plannedDeletes.length !== 1) throw new Error(`CF_SV8_GUARD_DELETE_COUNT:${plannedDeletes.length}`);
  const planned = plannedDeletes[0];
  if (planned.pt !== CF_SV8_AUTORUN.pt || planned.attributeName !== CF_SV8_AUTORUN.attributeName) {
    throw new Error(`CF_SV8_GUARD_SLOT_MISMATCH:${planned.pt}:${planned.attributeName}`);
  }

  const catalog = await getCatalog(accessToken, asin);
  const preview = await validationPreview(accessToken, CF_SV8_AUTORUN.sku, productType, plannedDeletes);

  return {
    status: preview.validationPassed ? "CF_SV8_100238_PT06_VALIDATION_PREVIEW_PASS" : "CF_SV8_100238_PT06_VALIDATION_PREVIEW_BLOCK",
    moduleVersion: MODULE_VERSION,
    readOnlyFreshAudit: true,
    validationPreviewOnly: true,
    sku: CF_SV8_AUTORUN.sku,
    asin,
    productType,
    listingStatus: status,
    buyable: status.includes("BUYABLE"),
    discoverable: status.includes("DISCOVERABLE"),
    currentErrorCount: errorIssues.length,
    currentIssues: issues.map(issue => ({
      code: String(issue?.code || ""),
      severity: String(issue?.severity || ""),
      message: String(issue?.message || ""),
      attributeNames: Array.isArray(issue?.attributeNames) ? issue.attributeNames : [],
    })),
    listingImages: listingImageSnapshot(listing),
    catalogHttpStatus: catalog.httpStatus,
    catalogOk: catalog.ok,
    catalogImages: catalogImageSnapshot(catalog.body),
    plannedDelete: planned,
    preview: {
      httpStatus: preview.httpStatus,
      responseOk: preview.responseOk,
      status: preview.status,
      submissionId: preview.submissionId,
      errorCount: preview.errorCount,
      issues: preview.issues,
      validationPassed: preview.validationPassed,
      requestBodySha256: preview.requestBodySha256,
    },
    amazonPersistentWrites: 0,
    inventoryWrites: 0,
    priceWrites: 0,
    b2bWrites: 0,
    adsWrites: 0,
    yahooWrites: 0,
    variationRelationWrites: 0,
    externalChanges: 0,
  };
}

async function handler(req, res) {
  try {
    const secret = getSecret();
    if (!secret) {
      return res.status(500).json({ ok: false, externalChanges: 0, error: "AMAZON_STOCK_API_SECRET is not set" });
    }
    if (String(req.headers["x-api-secret"] || "") !== secret) {
      return res.status(401).json({ ok: false, externalChanges: 0, error: "Unauthorized" });
    }

    const sku = String(req.body?.sku || "").trim();
    const dryRun = req.body?.dryRun !== false;
    if (!sku) throw new Error("sku is required");
    if (!dryRun) throw new Error("LIVE is intentionally disabled on this route; dryRun must be true");

    const accessToken = await getLwaAccessToken();
    const listing = await getListing(accessToken, sku);
    const summary = Array.isArray(listing?.summaries) ? listing.summaries[0] || {} : {};
    const productType = String(summary?.productType || "").trim();
    const asin = String(summary?.asin || "").trim();
    const title = String(summary?.itemName || "").trim();
    if (!productType) throw new Error("Listing productType could not be resolved");

    const plannedDeletes = buildDeletePlan(listing);
    const preview = await validationPreview(accessToken, sku, productType, plannedDeletes);

    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      sku,
      asin,
      title,
      productType,
      dryRun: true,
      validationPassed: preview.validationPassed,
      plannedDeletes,
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
      note: "VALIDATION_PREVIEW only. No Amazon listing mutation was persisted by this route.",
    });
  } catch (err) {
    console.error("Amazon image suppression preview error", err?.message || String(err));
    return res.status(400).json({
      ok: false,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      externalChanges: 0,
      error: err?.message || String(err),
    });
  }
}

express.application.listen = function amazonImageSuppressionPreviewListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  const server = originalListen.apply(this, args);
  setTimeout(async () => {
    try {
      console.log(`CF_SV8_100238_PREVIEW_RESULT=${JSON.stringify(await runCfSv8Autorun())}`);
    } catch (err) {
      console.error(`CF_SV8_100238_PREVIEW_ERROR=${JSON.stringify({
        moduleVersion: MODULE_VERSION,
        error: err?.message || String(err),
        amazonPersistentWrites: 0,
        inventoryWrites: 0,
        priceWrites: 0,
        b2bWrites: 0,
        adsWrites: 0,
        yahooWrites: 0,
        variationRelationWrites: 0,
        externalChanges: 0,
      })}`);
    }
  }, 5000);
  return server;
};

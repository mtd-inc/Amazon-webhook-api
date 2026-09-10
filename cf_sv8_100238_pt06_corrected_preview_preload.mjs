import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import "dotenv/config";

const MODULE_VERSION = "2026-09-10-cf-sv8-100238-pt06-corrected-preview-v1.0.0";
const RESULT_TAG = "CF_SV8_100238_PT06_CORRECTED_PREVIEW_RESULT";
const ERROR_TAG = "CF_SV8_100238_PT06_CORRECTED_PREVIEW_ERROR";
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
  expectedRequestBodySha256: "2327fa425c3bb40cd0de153fa6abd97007b2967a87716e1814e1208153b34c1f",
});

function safeJsonParse(text) {
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { return { rawText: String(text).slice(0, 4000) }; }
}

function getConfig() {
  const sellerId = String(process.env.SPAPI_SELLER_ID || "").trim();
  const marketplaceId = String(process.env.SPAPI_MARKETPLACE_ID || TARGET.marketplaceId).trim();
  const endpoint = String(process.env.SPAPI_ENDPOINT || "https://sellingpartnerapi-fe.amazon.com").replace(/\/$/, "");
  if (!sellerId) throw new Error("CF_SV8_GUARD_SPAPI_SELLER_ID_MISSING");
  if (marketplaceId !== TARGET.marketplaceId) {
    throw new Error(`CF_SV8_GUARD_MARKETPLACE_MISMATCH:${marketplaceId}`);
  }
  return { sellerId, marketplaceId, endpoint };
}

async function getLwaAccessToken() {
  const clientId = process.env.LWA_CLIENT_ID;
  const clientSecret = process.env.LWA_CLIENT_SECRET;
  const refreshToken = process.env.REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("CF_SV8_GUARD_LWA_ENV_MISSING");
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
    throw new Error(`CF_SV8_GUARD_LWA_TOKEN_FAILED:${response.status}`);
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

async function getListing(accessToken) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    includedData: "summaries,attributes,issues",
    issueLocale: "ja_JP",
  });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(TARGET.sku)}?${query}`;
  const response = await fetchWithTimeout(url, {
    method: "GET",
    headers: { "x-amz-access-token": accessToken, accept: "application/json" },
  });
  const json = safeJsonParse(await response.text());
  if (!response.ok) {
    throw new Error(`CF_SV8_FRESH_LISTING_GET_FAILED:${response.status}:${JSON.stringify(json)}`);
  }
  return json;
}

async function getCatalog(accessToken) {
  const { marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    includedData: "images,summaries,productTypes",
  });
  const url = `${endpoint}/catalog/2022-04-01/items/${encodeURIComponent(TARGET.asin)}?${query}`;
  const response = await fetchWithTimeout(url, {
    method: "GET",
    headers: { "x-amz-access-token": accessToken, accept: "application/json" },
  });
  const json = safeJsonParse(await response.text());
  if (!response.ok) {
    throw new Error(`CF_SV8_FRESH_CATALOG_GET_FAILED:${response.status}:${JSON.stringify(json)}`);
  }
  return json;
}

function sha256(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function issueAttributeNames(issue) {
  const names = [];
  if (Array.isArray(issue?.attributeNames)) names.push(...issue.attributeNames.map(String));
  if (issue?.attributeName) names.push(String(issue.attributeName));
  return [...new Set(names.filter(Boolean))];
}

function assertSingleMediaValue(attributes, attributeName, expectedUrl) {
  const values = attributes?.[attributeName];
  if (!Array.isArray(values) || values.length !== 1 || !values[0] || typeof values[0] !== "object") {
    throw new Error(`CF_SV8_GUARD_ATTRIBUTE_CARDINALITY:${attributeName}`);
  }
  const mediaLocation = String(values[0]?.media_location || "").trim();
  const marketplaceId = String(values[0]?.marketplace_id || "").trim();
  if (mediaLocation !== expectedUrl) {
    throw new Error(`CF_SV8_GUARD_MEDIA_MISMATCH:${attributeName}:${mediaLocation}`);
  }
  if (marketplaceId !== TARGET.marketplaceId) {
    throw new Error(`CF_SV8_GUARD_MEDIA_MARKETPLACE_MISMATCH:${attributeName}:${marketplaceId}`);
  }
  return [{ media_location: mediaLocation, marketplace_id: marketplaceId }];
}

function inspectFreshListing(listing) {
  const responseSku = String(listing?.sku || "").trim();
  if (responseSku && responseSku !== TARGET.sku) {
    throw new Error(`CF_SV8_GUARD_SKU_MISMATCH:${responseSku}`);
  }

  const summary = Array.isArray(listing?.summaries) ? listing.summaries[0] || {} : {};
  const asin = String(summary?.asin || "").trim();
  const productType = String(summary?.productType || "").trim();
  const statuses = Array.isArray(summary?.status) ? summary.status.map(String) : [];
  if (asin !== TARGET.asin) throw new Error(`CF_SV8_GUARD_ASIN_MISMATCH:${asin}`);
  if (productType !== TARGET.productType) throw new Error(`CF_SV8_GUARD_PRODUCT_TYPE_MISMATCH:${productType}`);
  if (!statuses.includes("BUYABLE") || !statuses.includes("DISCOVERABLE")) {
    throw new Error(`CF_SV8_GUARD_LISTING_STATUS_CHANGED:${JSON.stringify(statuses)}`);
  }

  const issues = Array.isArray(listing?.issues) ? listing.issues : [];
  const errorIssues = issues.filter(issue => String(issue?.severity || "").toUpperCase() === "ERROR");
  if (errorIssues.length !== 1) {
    throw new Error(`CF_SV8_GUARD_ERROR_COUNT_CHANGED:${errorIssues.length}`);
  }

  const targetIssue = errorIssues[0];
  const issueCode = String(targetIssue?.code || "");
  const message = String(targetIssue?.message || "");
  const attributeNames = issueAttributeNames(targetIssue);
  if (issueCode !== TARGET.issueCode || !/PT\s*0*6/i.test(message) || !attributeNames.includes("media_locator")) {
    throw new Error(`CF_SV8_GUARD_TARGET_ISSUE_CHANGED:${JSON.stringify({ issueCode, message, attributeNames })}`);
  }

  const attributes = listing?.attributes && typeof listing.attributes === "object" ? listing.attributes : {};
  const deleteValue = assertSingleMediaValue(attributes, TARGET.attributeName, TARGET.mediaLocation);
  assertSingleMediaValue(attributes, TARGET.controlAttributeName, TARGET.controlMediaLocation);

  return {
    productType,
    statuses,
    issue: {
      code: issueCode,
      severity: String(targetIssue?.severity || ""),
      message,
      attributeNames,
    },
    deleteValue,
    lastUpdatedDate: listing?.lastUpdatedDate || null,
    imageSlots: Object.keys(attributes)
      .filter(name => name === "main_product_image_locator" || /^other_product_image_locator_\d+$/.test(name))
      .sort((a, b) => {
        if (a === "main_product_image_locator") return -1;
        if (b === "main_product_image_locator") return 1;
        return Number(a.match(/_(\d+)$/)?.[1] || 999) - Number(b.match(/_(\d+)$/)?.[1] || 999);
      })
      .map(attributeName => ({
        attributeName,
        mediaLocation: String(attributes?.[attributeName]?.[0]?.media_location || ""),
      })),
  };
}

function buildPreviewBody(productType, deleteValue) {
  return {
    productType,
    patches: [{
      op: "delete",
      path: `/attributes/${TARGET.attributeName}`,
      value: deleteValue,
    }],
  };
}

async function runValidationPreview(accessToken, productType, deleteValue) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const body = buildPreviewBody(productType, deleteValue);
  const requestBodySha256 = sha256(body);
  if (requestBodySha256 !== TARGET.expectedRequestBodySha256) {
    throw new Error(`CF_SV8_GUARD_REQUEST_SHA_MISMATCH:${requestBodySha256}`);
  }

  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    issueLocale: "ja_JP",
    includedData: "issues",
    mode: "VALIDATION_PREVIEW",
  });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(TARGET.sku)}?${query}`;
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
  const warnings = issues.filter(issue => String(issue?.severity || "").toUpperCase() === "WARNING");
  const status = String(json?.status || "").toUpperCase();
  const validationPassed = response.ok && errors.length === 0 && (status === "VALID" || status === "ACCEPTED");

  return {
    httpStatus: response.status,
    responseOk: response.ok,
    status,
    submissionId: String(json?.submissionId || ""),
    issues,
    errorCount: errors.length,
    warningCount: warnings.length,
    validationPassed,
    requestBodySha256,
  };
}

function catalogImageSnapshot(catalog) {
  const rows = [];
  const groups = Array.isArray(catalog?.images) ? catalog.images : [];
  for (const group of groups) {
    const images = Array.isArray(group?.images) ? group.images : [];
    for (const image of images) {
      rows.push({
        marketplaceId: String(group?.marketplaceId || ""),
        variant: String(image?.variant || ""),
        link: String(image?.link || ""),
        height: image?.height ?? null,
        width: image?.width ?? null,
      });
    }
  }
  return rows;
}

async function runCorrectedPreview() {
  const accessToken = await getLwaAccessToken();

  // Phase 1: Fresh READ ONLY Listings + Catalog audit.
  const listing = await getListing(accessToken);
  const fresh = inspectFreshListing(listing);
  const catalog = await getCatalog(accessToken);
  const catalogImages = catalogImageSnapshot(catalog);

  // Phase 2: Amazon VALIDATION_PREVIEW only. No persistent PATCH path exists in this module.
  const preview = await runValidationPreview(accessToken, fresh.productType, fresh.deleteValue);

  return {
    status: preview.validationPassed
      ? "CF_SV8_100238_PT06_CORRECTED_VALIDATION_PREVIEW_PASS"
      : "CF_SV8_100238_PT06_CORRECTED_VALIDATION_PREVIEW_BLOCK",
    moduleVersion: MODULE_VERSION,
    sellerSku: TARGET.sku,
    asin: TARGET.asin,
    productType: fresh.productType,
    readOnlyFreshAudit: true,
    validationPreviewOnly: true,
    liveImplemented: false,
    listingStatus: fresh.statuses,
    buyable: fresh.statuses.includes("BUYABLE"),
    discoverable: fresh.statuses.includes("DISCOVERABLE"),
    lastUpdatedDate: fresh.lastUpdatedDate,
    currentErrorCount: 1,
    currentIssue: fresh.issue,
    imageSlots: fresh.imageSlots,
    catalogImages,
    catalogPt06Count: catalogImages.filter(image => String(image.variant).toUpperCase() === "PT06").length,
    plannedDelete: {
      pt: TARGET.pt,
      attributeName: TARGET.attributeName,
      patchPath: `/attributes/${TARGET.attributeName}`,
      mediaLocation: TARGET.mediaLocation,
      operation: "delete",
    },
    patchPaths: [`/attributes/${TARGET.attributeName}`],
    preview,
    amazonPersistentWrites: 0,
    priceMutation: 0,
    inventoryMutation: 0,
    b2bMutation: 0,
    amazonAdsMutation: 0,
    yahooMutation: 0,
    variationRelationMutation: 0,
    otherContentMutation: 0,
    externalChanges: 0,
  };
}

express.application.listen = function cfSv8100238Pt06CorrectedPreviewListen(...args) {
  const server = originalListen.apply(this, args);
  setTimeout(async () => {
    try {
      console.log(`${RESULT_TAG}=${JSON.stringify(await runCorrectedPreview())}`);
    } catch (error) {
      console.error(`${ERROR_TAG}=${JSON.stringify({
        moduleVersion: MODULE_VERSION,
        sellerSku: TARGET.sku,
        asin: TARGET.asin,
        error: error?.message || String(error),
        liveImplemented: false,
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
  }, 1800);
  return server;
};

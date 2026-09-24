import crypto from "node:crypto";
import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-09-24-search-intelligence-generic-keyword-preview-v1.0.0";
const ROUTE = "/amazon/listing/search-intelligence-generic-keyword-preview";
const REQUEST_TIMEOUT_MS = 20000;
const TARGET_FIELD = "generic_keyword";
const originalListen = express.application.listen;

function safeJsonParse(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { rawText: text }; }
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
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
    headers: { "content-type": "application/x-www-form-urlencoded" },
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
  if (!response.ok) throw new Error(`SP-API GET error: ${response.status} ${JSON.stringify(json).slice(0, 1200)}`);
  return json;
}

function requireString(body, key, { trim = true } = {}) {
  if (typeof body?.[key] !== "string") throw new Error(`CONTRACT_INVALID: ${key} must be a string`);
  const value = trim ? body[key].trim() : body[key];
  if (!value) throw new Error(`CONTRACT_INVALID: ${key} is required`);
  return value;
}

function exactGenericKeywordState(attributes) {
  const rows = Array.isArray(attributes?.[TARGET_FIELD]) ? attributes[TARGET_FIELD] : [];
  if (rows.length !== 1 || !rows[0] || typeof rows[0] !== "object" || Array.isArray(rows[0])) {
    throw new Error(`LIVE_ATTRIBUTE_SHAPE_UNSUPPORTED: ${TARGET_FIELD} rowCount=${rows.length}`);
  }
  if (!Object.prototype.hasOwnProperty.call(rows[0], "value")) {
    throw new Error(`LIVE_ATTRIBUTE_SHAPE_UNSUPPORTED: ${TARGET_FIELD}.value missing`);
  }
  return {
    value: String(rows[0].value ?? ""),
    rowTemplate: JSON.parse(JSON.stringify(rows[0])),
  };
}

function buildPatch(rowTemplate, proposedValue) {
  const row = { ...JSON.parse(JSON.stringify(rowTemplate)), value: proposedValue };
  return {
    op: "replace",
    path: `/attributes/${TARGET_FIELD}`,
    value: [row],
  };
}

async function validationPreviewPatch(accessToken, sku, productType, patch) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    issueLocale: "ja_JP",
    includedData: "issues",
    mode: "VALIDATION_PREVIEW",
  });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${query}`;
  const response = await fetchWithTimeout(url, {
    method: "PATCH",
    headers: {
      "x-amz-access-token": accessToken,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ productType, patches: [patch] }),
  });
  const json = safeJsonParse(await response.text());
  const issues = Array.isArray(json?.issues) ? json.issues : [];
  const errors = issues.filter(issue => String(issue?.severity || "").toUpperCase() === "ERROR");
  const status = String(json?.status || "").toUpperCase();
  return {
    httpStatus: response.status,
    responseOk: response.ok,
    status,
    submissionId: String(json?.submissionId || ""),
    issueCount: issues.length,
    errorCount: errors.length,
    issues,
    valid: response.ok && errors.length === 0 && (status === "VALID" || status === "ACCEPTED"),
  };
}

async function handler(req, res) {
  try {
    const secret = getSecret();
    if (!secret) {
      return res.status(500).json({
        ok: false,
        moduleVersion: MODULE_VERSION,
        route: ROUTE,
        readOnly: true,
        validationPreviewOnly: true,
        amazonPersistentWrites: 0,
        externalChanges: 0,
        error: "AMAZON_STOCK_API_SECRET is not set",
      });
    }
    if (String(req.headers["x-api-secret"] || "") !== secret) {
      return res.status(401).json({
        ok: false,
        moduleVersion: MODULE_VERSION,
        route: ROUTE,
        readOnly: true,
        validationPreviewOnly: true,
        amazonPersistentWrites: 0,
        externalChanges: 0,
        error: "Unauthorized",
      });
    }

    const body = req.body || {};
    const sellerSku = requireString(body, "sellerSku");
    const asin = requireString(body, "asin");
    const targetField = requireString(body, "targetField");
    const currentValue = requireString(body, "currentValue", { trim: false });
    const proposedValue = requireString(body, "proposedValue", { trim: false });
    const currentValueHash = requireString(body, "currentValueHash").toLowerCase();
    const proposedValueHash = requireString(body, "proposedValueHash").toLowerCase();
    const candidateId = requireString(body, "candidateId");
    const proposalId = requireString(body, "proposalId");

    if (targetField !== TARGET_FIELD) {
      throw new Error(`GUARD_BLOCKED: targetField=${targetField}`);
    }
    if (!/^[a-f0-9]{64}$/.test(currentValueHash) || !/^[a-f0-9]{64}$/.test(proposedValueHash)) {
      throw new Error("CONTRACT_INVALID: hash format");
    }
    if (sha256(currentValue) !== currentValueHash) {
      throw new Error("CONTRACT_HASH_MISMATCH: currentValue");
    }
    if (sha256(proposedValue) !== proposedValueHash) {
      throw new Error("CONTRACT_HASH_MISMATCH: proposedValue");
    }
    if (currentValue === proposedValue) {
      throw new Error("GUARD_BLOCKED: no-op proposedValue");
    }

    const accessToken = await getLwaAccessToken();
    const listing = await getListing(accessToken, sellerSku);
    const summary = Array.isArray(listing?.summaries) ? listing.summaries[0] || {} : {};
    const liveAsin = String(summary?.asin || "");
    const productType = String(summary?.productType || "");
    if (liveAsin !== asin) throw new Error(`LIVE_SOURCE_DRIFT: asin expected=${asin} actual=${liveAsin}`);
    if (!productType) throw new Error("LIVE_SOURCE_DRIFT: productType missing");

    const attributes = listing?.attributes && typeof listing.attributes === "object" ? listing.attributes : {};
    const liveGeneric = exactGenericKeywordState(attributes);
    if (liveGeneric.value !== currentValue) {
      throw new Error(
        `LIVE_SOURCE_DRIFT: ${TARGET_FIELD} expected=${JSON.stringify(currentValue)} actual=${JSON.stringify(liveGeneric.value)}`,
      );
    }
    if (sha256(liveGeneric.value) !== currentValueHash) {
      throw new Error("LIVE_SOURCE_DRIFT: current hash mismatch");
    }

    const patch = buildPatch(liveGeneric.rowTemplate, proposedValue);
    const preview = await validationPreviewPatch(accessToken, sellerSku, productType, patch);

    return res.status(preview.valid ? 200 : 409).json({
      ok: preview.valid,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      candidateId,
      proposalId,
      sellerSku,
      asin,
      productType,
      targetField: TARGET_FIELD,
      contract: {
        currentValueHash,
        proposedValueHash,
      },
      liveSource: {
        currentValue: liveGeneric.value,
        currentValueHash: sha256(liveGeneric.value),
        rowShapeKeys: Object.keys(liveGeneric.rowTemplate).sort(),
      },
      patch: {
        paths: [patch.path],
        proposedValue,
        proposedValueHash: sha256(proposedValue),
      },
      preview,
      brandTouched: false,
      manufacturerTouched: false,
      inventoryTouched: false,
      priceTouched: false,
      adsTouched: false,
      readOnly: true,
      validationPreviewOnly: true,
      amazonPersistentWrites: 0,
      externalChanges: 0,
    });
  } catch (err) {
    console.error("Search Intelligence generic keyword preview error", err?.message || String(err));
    return res.status(400).json({
      ok: false,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      readOnly: true,
      validationPreviewOnly: true,
      amazonPersistentWrites: 0,
      externalChanges: 0,
      error: err?.message || String(err),
    });
  }
}

express.application.listen = function searchIntelligenceGenericKeywordPreviewListen(...args) {
  const alreadyRegistered = Boolean(
    this?._router?.stack?.some(layer => layer?.route?.path === ROUTE),
  );
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
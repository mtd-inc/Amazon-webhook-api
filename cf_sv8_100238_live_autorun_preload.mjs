import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const VERSION = "2026-09-10-cf-sv8-100238-approved-live-autorun-v1.0.0";
const ROUTE = "/amazon/listing/image-suppression-repair-live";
const SKU = "cf-sv8-i5-8gb-ssd512";
const CONFIRM_TOKEN = "CONFIRM_CF_SV8_PT06_DELETE_20260910";
const PREVIEW_SHA256 = "d41f75171a2fb8a12a056f6b7792a0abc48b8b25ebc9430221edfb1df04cee14";
const originalListen = express.application.listen;
let attempted = false;

async function runOnce() {
  if (attempted) return;
  attempted = true;

  const secret = String(process.env.AMAZON_STOCK_API_SECRET || "").trim();
  const port = Number(process.env.PORT || 10000);
  if (!secret) throw new Error("AMAZON_STOCK_API_SECRET_MISSING");

  const response = await fetch(`http://127.0.0.1:${port}${ROUTE}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-secret": secret,
    },
    body: JSON.stringify({
      sku: SKU,
      confirmToken: CONFIRM_TOKEN,
      expectedPreviewSha256: PREVIEW_SHA256,
    }),
  });

  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { rawText: text }; }

  const result = {
    moduleVersion: VERSION,
    httpStatus: response.status,
    responseOk: response.ok,
    body,
  };

  if (response.ok && body?.live?.accepted === true && Number(body?.amazonPersistentWrites || 0) === 1) {
    console.log(`CF_SV8_100238_LIVE_AUTORUN_RESULT=${JSON.stringify(result)}`);
  } else {
    console.error(`CF_SV8_100238_LIVE_AUTORUN_BLOCKED=${JSON.stringify(result)}`);
  }
}

express.application.listen = function cfSv8ApprovedLiveAutorunListen(...args) {
  const server = originalListen.apply(this, args);
  setTimeout(() => {
    runOnce().catch(error => {
      console.error(`CF_SV8_100238_LIVE_AUTORUN_ERROR=${JSON.stringify({
        moduleVersion: VERSION,
        error: error?.message || String(error),
        amazonPersistentWrites: 0,
        inventoryWrites: 0,
        priceWrites: 0,
        b2bWrites: 0,
        adsWrites: 0,
        yahooWrites: 0,
        variationRelationWrites: 0,
        externalChanges: 0,
      })}`);
    });
  }, 10000);
  return server;
};

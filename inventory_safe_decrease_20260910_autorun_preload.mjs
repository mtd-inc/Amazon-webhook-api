import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const VERSION = "2026-09-10-g83-replacement-256-live-v1.0.0";
const FRESH = "/amazon/stock/fresh-get";
const ORDERS = "/amazon/orders/fresh-gate";
const UPDATE = "/amazon/stock/update";
const TARGET = {
  sku: "g83-hs-i5-11g-8gb-ssd256-r1",
  asin: "B0HJ8L6KJY",
  from: 0,
  target: 18,
  reservation: true,
  leadTimeBusinessDays: 3,
  restockDate: "2026-09-15"
};
const originalListen = express.application.listen;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function post(port, path, secret, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-secret": secret },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { rawText: text }; }
  return { httpStatus: response.status, ok: response.ok, body: json };
}

function freshMap(resp) {
  return new Map((Array.isArray(resp?.body?.results) ? resp.body.results : []).map(x => [x?.sku, x]));
}

function getFreshRow(resp) {
  return freshMap(resp).get(TARGET.sku) || null;
}

function identityOk(row) {
  return Boolean(row?.ok && row.asin === TARGET.asin);
}

function previewValid(resp) {
  return Boolean(
    resp?.ok &&
    resp?.body?.ok === true &&
    resp?.body?.dryRun === true &&
    String(resp?.body?.result?.status || "") === "VALID" &&
    Array.isArray(resp?.body?.result?.issues) &&
    resp.body.result.issues.length === 0
  );
}

express.application.listen = function g83Replacement256ApprovedLive(...args) {
  const server = originalListen.apply(this, args);
  const port = Number(process.env.PORT || 10000);
  const secret = String(process.env.AMAZON_STOCK_API_SECRET || "").trim();

  setTimeout(async () => {
    let amazonInventoryWrites = 0;
    try {
      if (!secret) throw new Error("AMAZON_STOCK_API_SECRET_MISSING");

      const beforeResp = await post(port, FRESH, secret, { skus: [TARGET.sku] });
      const before = getFreshRow(beforeResp);
      if (!identityOk(before)) {
        throw new Error(`FRESH_IDENTITY_BLOCK:${JSON.stringify(before)}`);
      }
      if (Number(before.errorCount) !== 0) {
        throw new Error(`LISTING_ERROR_BLOCK:${JSON.stringify(before)}`);
      }

      const beforeQty = Number(before.availableQuantity);
      if (beforeQty === TARGET.target) {
        console.log(`G83_REPLACEMENT_256_LIVE_RESULT=${JSON.stringify({
          status: "ALREADY_AT_18_NO_WRITE",
          moduleVersion: VERSION,
          target: TARGET,
          before,
          amazonInventoryWrites: 0,
          priceWrites: 0,
          b2bWrites: 0,
          adsWrites: 0,
          yahooWrites: 0,
          variationWrites: 0,
          contentWrites: 0
        })}`);
        return;
      }
      if (beforeQty !== TARGET.from) {
        throw new Error(`UNEXPECTED_START_QUANTITY_BLOCK:${beforeQty}`);
      }

      const orders = await post(port, ORDERS, secret, { skus: [TARGET.sku], lookbackHours: 168 });
      if (!orders.ok || orders.body?.ok !== true || Number(orders.body?.totalMatchingOpenQty || 0) !== 0) {
        throw new Error(`ORDERS_GATE_BLOCK:${JSON.stringify(orders)}`);
      }

      const preview = await post(port, UPDATE, secret, {
        sku: TARGET.sku,
        quantity: TARGET.target,
        dryRun: true,
        reservation: TARGET.reservation,
        leadTimeBusinessDays: TARGET.leadTimeBusinessDays,
        restockDate: TARGET.restockDate
      });
      if (!previewValid(preview)) {
        throw new Error(`VALIDATION_PREVIEW_BLOCK:${JSON.stringify(preview)}`);
      }

      const lastSecondResp = await post(port, FRESH, secret, { skus: [TARGET.sku] });
      const lastSecond = getFreshRow(lastSecondResp);
      if (!identityOk(lastSecond) || Number(lastSecond.availableQuantity) !== TARGET.from || Number(lastSecond.errorCount) !== 0) {
        throw new Error(`LAST_SECOND_FRESH_BLOCK:${JSON.stringify(lastSecond)}`);
      }

      const lastOrders = await post(port, ORDERS, secret, { skus: [TARGET.sku], lookbackHours: 168 });
      if (!lastOrders.ok || lastOrders.body?.ok !== true || Number(lastOrders.body?.totalMatchingOpenQty || 0) !== 0) {
        throw new Error(`LAST_SECOND_ORDERS_BLOCK:${JSON.stringify(lastOrders)}`);
      }

      const live = await post(port, UPDATE, secret, {
        sku: TARGET.sku,
        quantity: TARGET.target,
        dryRun: false,
        reservation: TARGET.reservation,
        leadTimeBusinessDays: TARGET.leadTimeBusinessDays,
        restockDate: TARGET.restockDate
      });
      if (!live.ok || live.body?.ok !== true || live.body?.dryRun !== false || String(live.body?.result?.status || "") !== "ACCEPTED") {
        throw new Error(`LIVE_UPDATE_BLOCK:${JSON.stringify(live)}`);
      }
      amazonInventoryWrites = 1;

      let after = null;
      let verified = false;
      for (let attempt = 1; attempt <= 20; attempt += 1) {
        const afterResp = await post(port, FRESH, secret, { skus: [TARGET.sku] });
        after = getFreshRow(afterResp);
        verified = Boolean(
          identityOk(after) &&
          Number(after.availableQuantity) === TARGET.target &&
          Number(after.errorCount) === 0
        );
        if (verified) break;
        await sleep(3000);
      }

      console.log(`G83_REPLACEMENT_256_LIVE_RESULT=${JSON.stringify({
        status: verified ? "G83_REPLACEMENT_256_18_PASS" : "G83_REPLACEMENT_256_POSTVERIFY_PENDING",
        moduleVersion: VERSION,
        target: TARGET,
        before,
        ordersGate: {
          httpStatus: orders.httpStatus,
          ok: orders.ok && orders.body?.ok === true,
          matchingLineCount: Number(orders.body?.matchingLineCount || 0),
          totalMatchingOpenQty: Number(orders.body?.totalMatchingOpenQty || 0)
        },
        validationPreview: {
          httpStatus: preview.httpStatus,
          status: preview.body?.result?.status || null,
          submissionId: preview.body?.result?.submissionId || null,
          issues: preview.body?.result?.issues || [],
          availabilityPreview: preview.body?.availabilityPreview || null
        },
        live: {
          httpStatus: live.httpStatus,
          status: live.body?.result?.status || null,
          submissionId: live.body?.result?.submissionId || null,
          operation: live.body?.operation || null,
          availability: live.body?.availability || null
        },
        after,
        amazonInventoryWrites,
        priceWrites: 0,
        b2bWrites: 0,
        adsWrites: 0,
        yahooWrites: 0,
        variationWrites: 0,
        contentWrites: 0
      })}`);
    } catch (error) {
      console.error(`G83_REPLACEMENT_256_LIVE_ERROR=${JSON.stringify({
        moduleVersion: VERSION,
        target: TARGET,
        error: error?.message || String(error),
        amazonInventoryWrites,
        priceWrites: 0,
        b2bWrites: 0,
        adsWrites: 0,
        yahooWrites: 0,
        variationWrites: 0,
        contentWrites: 0
      })}`);
    }
  }, 5000);

  return server;
};

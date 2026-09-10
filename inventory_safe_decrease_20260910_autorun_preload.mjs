import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const VERSION = "2026-09-10-cfsv8-512-live-zero-v1.0.0";
const FRESH = "/amazon/stock/fresh-get";
const ORDERS = "/amazon/orders/fresh-gate";
const UPDATE = "/amazon/stock/update";
const TARGET = {
  sku: "cf-sv8-i5-8gb-ssd512",
  asin: "B0GH7GWDVP",
  from: 1,
  target: 0,
  reservation: false
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

function freshRow(resp) {
  const rows = Array.isArray(resp?.body?.results) ? resp.body.results : [];
  return rows.find(x => x?.sku === TARGET.sku) || null;
}

function freshGuard(row, quantity) {
  return Boolean(
    row?.ok === true &&
    row.asin === TARGET.asin &&
    Number(row.availableQuantity) === quantity &&
    Number(row.errorCount) === 0
  );
}

function ordersClear(resp) {
  return Boolean(
    resp?.ok === true &&
    resp?.body?.ok === true &&
    Number(resp.body.totalMatchingOpenQty || 0) === 0
  );
}

function previewValid(resp) {
  return Boolean(
    resp?.ok === true &&
    resp?.body?.ok === true &&
    resp?.body?.dryRun === true &&
    String(resp.body?.result?.status || "") === "VALID" &&
    Array.isArray(resp.body?.result?.issues) &&
    resp.body.result.issues.length === 0
  );
}

express.application.listen = function cfSv8512ApprovedLiveZero(...args) {
  const server = originalListen.apply(this, args);
  const port = Number(process.env.PORT || 10000);
  const secret = String(process.env.AMAZON_STOCK_API_SECRET || "").trim();

  setTimeout(async () => {
    let amazonInventoryWrites = 0;
    try {
      if (!secret) throw new Error("AMAZON_STOCK_API_SECRET_MISSING");

      const beforeResp = await post(port, FRESH, secret, { skus: [TARGET.sku] });
      const before = freshRow(beforeResp);

      if (before?.ok === true && before.asin === TARGET.asin && Number(before.availableQuantity) === TARGET.target && Number(before.errorCount) === 0) {
        console.log(`CFSV8_512_LIVE_ZERO_RESULT=${JSON.stringify({
          status: "ALREADY_ZERO_NO_WRITE",
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

      if (!freshGuard(before, TARGET.from)) {
        throw new Error(`FRESH_PRECHECK_BLOCK:${JSON.stringify(before)}`);
      }

      const orders = await post(port, ORDERS, secret, { skus: [TARGET.sku], lookbackHours: 168 });
      if (!ordersClear(orders)) {
        throw new Error(`ORDERS_GATE_BLOCK:${JSON.stringify(orders)}`);
      }

      const preview = await post(port, UPDATE, secret, {
        sku: TARGET.sku,
        quantity: TARGET.target,
        dryRun: true,
        reservation: false
      });
      if (!previewValid(preview)) {
        throw new Error(`VALIDATION_PREVIEW_BLOCK:${JSON.stringify(preview)}`);
      }

      const lastFreshResp = await post(port, FRESH, secret, { skus: [TARGET.sku] });
      const lastFresh = freshRow(lastFreshResp);
      if (!freshGuard(lastFresh, TARGET.from)) {
        throw new Error(`LAST_SECOND_FRESH_BLOCK:${JSON.stringify(lastFresh)}`);
      }

      const lastOrders = await post(port, ORDERS, secret, { skus: [TARGET.sku], lookbackHours: 168 });
      if (!ordersClear(lastOrders)) {
        throw new Error(`LAST_SECOND_ORDERS_BLOCK:${JSON.stringify(lastOrders)}`);
      }

      const live = await post(port, UPDATE, secret, {
        sku: TARGET.sku,
        quantity: TARGET.target,
        dryRun: false,
        reservation: false
      });
      if (
        !live.ok ||
        live.body?.ok !== true ||
        live.body?.dryRun !== false ||
        String(live.body?.result?.status || "") !== "ACCEPTED"
      ) {
        throw new Error(`LIVE_UPDATE_BLOCK:${JSON.stringify(live)}`);
      }
      amazonInventoryWrites = 1;

      let after = null;
      let verified = false;
      for (let attempt = 1; attempt <= 20; attempt += 1) {
        const afterResp = await post(port, FRESH, secret, { skus: [TARGET.sku] });
        after = freshRow(afterResp);
        verified = freshGuard(after, TARGET.target);
        if (verified) break;
        await sleep(3000);
      }

      console.log(`CFSV8_512_LIVE_ZERO_RESULT=${JSON.stringify({
        status: verified ? "CFSV8_512_ZERO_PASS" : "CFSV8_512_POSTVERIFY_PENDING",
        moduleVersion: VERSION,
        target: TARGET,
        before,
        ordersGate: {
          httpStatus: orders.httpStatus,
          ok: ordersClear(orders),
          matchingLineCount: Number(orders.body?.matchingLineCount || 0),
          totalMatchingOpenQty: Number(orders.body?.totalMatchingOpenQty || 0)
        },
        validationPreview: {
          httpStatus: preview.httpStatus,
          status: preview.body?.result?.status || null,
          submissionId: preview.body?.result?.submissionId || null,
          issues: preview.body?.result?.issues || []
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
      console.error(`CFSV8_512_LIVE_ZERO_ERROR=${JSON.stringify({
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

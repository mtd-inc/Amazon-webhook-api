import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const VERSION = "2026-09-10-l580-inventory-live-v1.0.0";
const FRESH = "/amazon/stock/fresh-get";
const UPDATE = "/amazon/stock/update";
const ORDERS = "/amazon/orders/fresh-gate";
const TARGET = { sku: "EI-8OK8-6YEV", asin: "B0H4VKB13S", before: 0, target: 1 };
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
  return Array.isArray(resp?.body?.results) ? resp.body.results.find(x => x?.sku === TARGET.sku) || null : null;
}

function exactFresh(row, quantity) {
  return Boolean(row?.ok) &&
    row.asin === TARGET.asin &&
    Number(row.availableQuantity) === quantity &&
    Number(row.errorCount) === 0;
}

express.application.listen = function approvedL580InventoryLive(...args) {
  const server = originalListen.apply(this, args);
  const port = Number(process.env.PORT || 10000);
  const secret = String(process.env.AMAZON_STOCK_API_SECRET || "").trim();

  setTimeout(async () => {
    let writes = 0;
    try {
      if (!secret) throw new Error("AMAZON_STOCK_API_SECRET_MISSING");

      const initialResp = await post(port, FRESH, secret, { skus: [TARGET.sku] });
      const initial = freshRow(initialResp);
      if (exactFresh(initial, TARGET.target)) {
        console.log(`L580_INVENTORY_LIVE_RESULT=${JSON.stringify({
          status: "ALREADY_1_PASS",
          moduleVersion: VERSION,
          target: TARGET,
          initial,
          amazonInventoryWrites: 0,
          priceWrites: 0,
          b2bWrites: 0,
          adsWrites: 0,
          yahooWrites: 0
        })}`);
        return;
      }
      if (!exactFresh(initial, TARGET.before)) {
        throw new Error(`INITIAL_FRESH_GUARD_BLOCK:${JSON.stringify(initial)}`);
      }

      const orders = await post(port, ORDERS, secret, { skus: [TARGET.sku], lookbackHours: 168 });
      if (!orders.ok || orders.body?.ok !== true || Number(orders.body?.totalMatchingOpenQty || 0) !== 0) {
        throw new Error(`ORDERS_GATE_BLOCK:${JSON.stringify(orders)}`);
      }

      const preview = await post(port, UPDATE, secret, {
        sku: TARGET.sku,
        quantity: TARGET.target,
        dryRun: true,
        reservation: false
      });
      if (!preview.ok || preview.body?.ok !== true || preview.body?.dryRun !== true || String(preview.body?.result?.status || "") !== "VALID") {
        throw new Error(`VALIDATION_PREVIEW_BLOCK:${JSON.stringify(preview)}`);
      }

      const lastSecondResp = await post(port, FRESH, secret, { skus: [TARGET.sku] });
      const lastSecond = freshRow(lastSecondResp);
      if (!exactFresh(lastSecond, TARGET.before)) {
        throw new Error(`LAST_SECOND_FRESH_GUARD_BLOCK:${JSON.stringify(lastSecond)}`);
      }

      const live = await post(port, UPDATE, secret, {
        sku: TARGET.sku,
        quantity: TARGET.target,
        dryRun: false,
        reservation: false
      });
      if (!live.ok || live.body?.ok !== true || live.body?.dryRun !== false || String(live.body?.result?.status || "") !== "ACCEPTED") {
        throw new Error(`LIVE_UPDATE_BLOCK:${JSON.stringify(live)}`);
      }
      writes = 1;

      let final = null;
      for (let i = 0; i < 12; i++) {
        await sleep(i === 0 ? 1500 : 3000);
        const finalResp = await post(port, FRESH, secret, { skus: [TARGET.sku] });
        final = freshRow(finalResp);
        if (exactFresh(final, TARGET.target)) break;
      }

      if (!exactFresh(final, TARGET.target)) {
        throw new Error(`POST_LIVE_VERIFY_PENDING:${JSON.stringify(final)}`);
      }

      console.log(`L580_INVENTORY_LIVE_RESULT=${JSON.stringify({
        status: "L580_INVENTORY_0_TO_1_PASS",
        moduleVersion: VERSION,
        target: TARGET,
        initial,
        ordersGate: {
          openOrderCount: Number(orders.body?.openOrderCount || 0),
          matchingLineCount: Number(orders.body?.matchingLineCount || 0),
          totalMatchingOpenQty: Number(orders.body?.totalMatchingOpenQty || 0)
        },
        validationPreview: {
          status: preview.body?.result?.status || null,
          submissionId: preview.body?.result?.submissionId || null
        },
        live: {
          status: live.body?.result?.status || null,
          submissionId: live.body?.result?.submissionId || null
        },
        final,
        amazonInventoryWrites: writes,
        priceWrites: 0,
        b2bWrites: 0,
        adsWrites: 0,
        yahooWrites: 0
      })}`);
    } catch (error) {
      console.error(`L580_INVENTORY_LIVE_ERROR=${JSON.stringify({
        moduleVersion: VERSION,
        error: error?.message || String(error),
        amazonInventoryWrites: writes,
        priceWrites: 0,
        b2bWrites: 0,
        adsWrites: 0,
        yahooWrites: 0
      })}`);
    }
  }, 5000);

  return server;
};

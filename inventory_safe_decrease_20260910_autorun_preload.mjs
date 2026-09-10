import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const VERSION = "2026-09-10-l580-inventory-postlive-audit-v1.0.0";
const FRESH = "/amazon/stock/fresh-get";
const ORDERS = "/amazon/orders/fresh-gate";
const TARGET = { sku: "EI-8OK8-6YEV", asin: "B0H4VKB13S", target: 1 };
const originalListen = express.application.listen;

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

express.application.listen = function l580PostLiveAudit(...args) {
  const server = originalListen.apply(this, args);
  const port = Number(process.env.PORT || 10000);
  const secret = String(process.env.AMAZON_STOCK_API_SECRET || "").trim();

  setTimeout(async () => {
    try {
      if (!secret) throw new Error("AMAZON_STOCK_API_SECRET_MISSING");
      const freshResp = await post(port, FRESH, secret, { skus: [TARGET.sku] });
      const fresh = freshRow(freshResp);
      const orders = await post(port, ORDERS, secret, { skus: [TARGET.sku], lookbackHours: 168 });
      const pass = Boolean(
        fresh?.ok &&
        fresh.asin === TARGET.asin &&
        Number(fresh.availableQuantity) === TARGET.target &&
        Number(fresh.errorCount) === 0 &&
        orders.ok && orders.body?.ok === true &&
        Number(orders.body?.totalMatchingOpenQty || 0) === 0
      );
      console.log(`L580_INVENTORY_POSTLIVE_AUDIT=${JSON.stringify({
        status: pass ? "L580_INVENTORY_1_PASS" : "L580_INVENTORY_POSTLIVE_PENDING",
        moduleVersion: VERSION,
        target: TARGET,
        fresh,
        ordersGate: {
          matchingLineCount: Number(orders.body?.matchingLineCount || 0),
          totalMatchingOpenQty: Number(orders.body?.totalMatchingOpenQty || 0)
        },
        readOnly: true,
        amazonInventoryWrites: 0,
        priceWrites: 0,
        b2bWrites: 0,
        adsWrites: 0,
        yahooWrites: 0
      })}`);
    } catch (error) {
      console.error(`L580_INVENTORY_POSTLIVE_AUDIT_ERROR=${JSON.stringify({
        moduleVersion: VERSION,
        error: error?.message || String(error),
        amazonInventoryWrites: 0,
        priceWrites: 0,
        b2bWrites: 0,
        adsWrites: 0,
        yahooWrites: 0
      })}`);
    }
  }, 5000);

  return server;
};

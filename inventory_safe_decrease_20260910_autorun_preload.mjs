import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const VERSION = "2026-09-10-g83-inventory-ssot-audit-v1.0.0";
const FRESH = "/amazon/stock/fresh-get";
const ORDERS = "/amazon/orders/fresh-gate";
const TARGETS = [
  { role: "LEGACY_SUB_256", sku: "g83-i5-11-8gb-ssd256", asin: "B0GN84QRCF", expected: 0, catalogKeep: false },
  { role: "HEALTHY_CHILD_512", sku: "SO-9QJ3-7SHR", asin: "B0FPC2JKBY", expected: 0, catalogKeep: true },
  { role: "REPLACEMENT_256", sku: "g83-hs-i5-11g-8gb-ssd256-r1", asin: "B0HJ8L6KJY", expected: 18, catalogKeep: true },
  { role: "REPLACEMENT_1TB", sku: "g83-hs-i5-11g-8gb-ssd1tb-r1", asin: "B0HJ8SKQGG", expected: 0, catalogKeep: true },
  { role: "RETIRED_BAD_256", sku: "F7-AF7O-IGX5", asin: "B0FN3KQFR3", expected: 0, catalogKeep: false },
  { role: "RETIRED_BAD_1TB", sku: "9K-D0RA-4R8V", asin: "B0FPC4R7ZG", expected: 0, catalogKeep: false }
];
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

function freshMap(resp) {
  return new Map((Array.isArray(resp?.body?.results) ? resp.body.results : []).map(x => [x?.sku, x]));
}

express.application.listen = function g83InventorySsotAudit(...args) {
  const server = originalListen.apply(this, args);
  const port = Number(process.env.PORT || 10000);
  const secret = String(process.env.AMAZON_STOCK_API_SECRET || "").trim();

  setTimeout(async () => {
    try {
      if (!secret) throw new Error("AMAZON_STOCK_API_SECRET_MISSING");
      const freshResp = await post(port, FRESH, secret, { skus: TARGETS.map(x => x.sku) });
      const map = freshMap(freshResp);
      const rows = [];
      for (const t of TARGETS) {
        const fresh = map.get(t.sku) || null;
        const orders = await post(port, ORDERS, secret, { skus: [t.sku], lookbackHours: 168 });
        const current = fresh?.ok ? Number(fresh.availableQuantity) : null;
        let inventoryAction = "REVIEW";
        if (current !== null && current === t.expected) inventoryAction = "ALREADY_EXPECTED";
        else if (current !== null && current > t.expected) inventoryAction = "SAFE_DECREASE_CANDIDATE";
        else if (current !== null && current < t.expected) inventoryAction = "INCREASE_REQUIRES_APPROVAL";
        if (fresh && fresh.ok === false) inventoryAction = "FRESH_ERROR_REVIEW";
        rows.push({
          ...t,
          fresh,
          ordersGate: {
            ok: orders.ok && orders.body?.ok === true,
            matchingLineCount: Number(orders.body?.matchingLineCount || 0),
            totalMatchingOpenQty: Number(orders.body?.totalMatchingOpenQty || 0)
          },
          inventoryAction
        });
      }
      console.log(`G83_INVENTORY_SSOT_AUDIT=${JSON.stringify({
        status: "READ_ONLY_COMPLETE",
        moduleVersion: VERSION,
        rows,
        readOnly: true,
        amazonInventoryWrites: 0,
        priceWrites: 0,
        b2bWrites: 0,
        adsWrites: 0,
        yahooWrites: 0
      })}`);
    } catch (error) {
      console.error(`G83_INVENTORY_SSOT_AUDIT_ERROR=${JSON.stringify({
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

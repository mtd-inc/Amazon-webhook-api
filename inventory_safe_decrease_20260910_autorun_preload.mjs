import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const VERSION = "2026-09-10-g83-replacement-inventory-handoff-preflight-v1.0.0";
const FRESH = "/amazon/stock/fresh-get";
const ORDERS = "/amazon/orders/fresh-gate";
const UPDATE = "/amazon/stock/update";

// Snapshot of current inventory SSOT/mapping reviewed immediately before this run.
// This module never performs LIVE writes.
const TARGETS = [
  {
    role: "REPLACEMENT_8GB_256",
    sku: "g83-hs-i5-11g-8gb-ssd256-r1",
    asin: "B0HJ8L6KJY",
    expected: 18,
    mappingEnabled: true,
    inventoryMode: "予約販売",
    poolId: "POOL-G83-11G",
    reservation: true,
    leadTimeBusinessDays: 3,
    restockDate: "2026-09-15",
    allowedIssueCodes: []
  },
  {
    role: "REPLACEMENT_8GB_1TB",
    sku: "g83-hs-i5-11g-8gb-ssd1tb-r1",
    asin: "B0HJ8SKQGG",
    expected: 0,
    mappingEnabled: true,
    inventoryMode: "共通在庫",
    poolId: "POOL-G83-11G",
    reservation: false,
    allowedIssueCodes: []
  },
  {
    role: "RETIRED_OLD_8GB_256",
    sku: "F7-AF7O-IGX5",
    asin: "B0FN3KQFR3",
    expected: 0,
    mappingEnabled: false,
    inventoryMode: "退役",
    poolId: "POOL-G83-11G",
    reservation: false,
    allowedIssueCodes: ["18653"]
  },
  {
    role: "RETIRED_OLD_8GB_1TB",
    sku: "9K-D0RA-4R8V",
    asin: "B0FPC4R7ZG",
    expected: 0,
    mappingEnabled: false,
    inventoryMode: "退役",
    poolId: "POOL-G83-11G",
    reservation: false,
    allowedIssueCodes: ["18653"]
  },
  {
    role: "RETIRED_LEGACY_SUB_8GB_256",
    sku: "g83-i5-11-8gb-ssd256",
    asin: "B0GN84QRCF",
    expected: 0,
    mappingEnabled: false,
    inventoryMode: "予約サブ停止",
    poolId: "POOL-G83-11G",
    reservation: false,
    allowedIssueCodes: []
  },
  {
    role: "CATALOG_CHILD_8GB_512",
    sku: "SO-9QJ3-7SHR",
    asin: "B0FPC2JKBY",
    expected: 0,
    mappingEnabled: true,
    inventoryMode: "共通在庫",
    poolId: "POOL-G83-11G",
    reservation: false,
    allowedIssueCodes: []
  },
  {
    role: "CATALOG_CHILD_16GB_256",
    sku: "E7-YLJ3-F9CY",
    asin: "B0GZBHBQN2",
    expected: 0,
    mappingEnabled: true,
    inventoryMode: "共通在庫",
    poolId: "POOL-G83-11G",
    reservation: false,
    allowedIssueCodes: []
  },
  {
    role: "CATALOG_CHILD_16GB_512",
    sku: "5K-G098-FO9O",
    asin: "B0FPC52B8K",
    expected: 0,
    mappingEnabled: true,
    inventoryMode: "共通在庫",
    poolId: "POOL-G83-11G",
    reservation: false,
    allowedIssueCodes: []
  },
  {
    role: "CATALOG_CHILD_16GB_1TB",
    sku: "QH-ITJ6-BTTC",
    asin: "B0FPC385LM",
    expected: 0,
    mappingEnabled: true,
    inventoryMode: "共通在庫",
    poolId: "POOL-G83-11G",
    reservation: false,
    allowedIssueCodes: []
  }
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

function issueGuard(t, fresh) {
  if (!fresh?.ok) return false;
  const codes = Array.isArray(fresh.issueCodes) ? fresh.issueCodes.map(String) : [];
  return codes.every(code => t.allowedIssueCodes.includes(code));
}

function classify(t, fresh) {
  if (!fresh?.ok || fresh.asin !== t.asin) return "IDENTITY_OR_FRESH_REVIEW";
  if (!issueGuard(t, fresh)) return "LISTING_ERROR_REVIEW";
  const current = Number(fresh.availableQuantity);
  if (!Number.isFinite(current)) return "QUANTITY_REVIEW";
  if (current === t.expected) return "NO_CHANGE";
  if (current < t.expected) return "INCREASE_REQUIRES_APPROVAL";
  return "DECREASE_REQUIRES_APPROVAL";
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

express.application.listen = function g83ReplacementInventoryHandoffPreflight(...args) {
  const server = originalListen.apply(this, args);
  const port = Number(process.env.PORT || 10000);
  const secret = String(process.env.AMAZON_STOCK_API_SECRET || "").trim();

  setTimeout(async () => {
    try {
      if (!secret) throw new Error("AMAZON_STOCK_API_SECRET_MISSING");

      const freshResp = await post(port, FRESH, secret, { skus: TARGETS.map(x => x.sku) });
      if (!freshResp.ok || freshResp.body?.ok !== true) {
        throw new Error(`FRESH_AUDIT_FAILED:${JSON.stringify(freshResp)}`);
      }
      const map = freshMap(freshResp);
      const rows = [];

      for (const t of TARGETS) {
        const fresh = map.get(t.sku) || null;
        const orders = await post(port, ORDERS, secret, { skus: [t.sku], lookbackHours: 168 });
        const orderGate = {
          httpStatus: orders.httpStatus,
          ok: orders.ok && orders.body?.ok === true,
          matchingLineCount: Number(orders.body?.matchingLineCount || 0),
          totalMatchingOpenQty: Number(orders.body?.totalMatchingOpenQty || 0)
        };
        rows.push({
          role: t.role,
          sku: t.sku,
          asin: t.asin,
          ssotExpected: t.expected,
          mappingEnabled: t.mappingEnabled,
          inventoryMode: t.inventoryMode,
          poolId: t.poolId,
          reservation: t.reservation,
          fresh,
          ordersGate: orderGate,
          action: classify(t, fresh)
        });
      }

      const target = TARGETS[0];
      const targetFresh = map.get(target.sku) || null;
      const targetRow = rows.find(x => x.sku === target.sku);
      let validationPreview = null;
      let readyForLiveApproval = false;

      const eligibleForPreview = Boolean(
        targetFresh?.ok &&
        targetFresh.asin === target.asin &&
        Number(targetFresh.availableQuantity) === 0 &&
        Number(targetFresh.errorCount) === 0 &&
        targetRow?.ordersGate?.ok === true &&
        Number(targetRow?.ordersGate?.totalMatchingOpenQty || 0) === 0
      );

      if (eligibleForPreview) {
        const preview = await post(port, UPDATE, secret, {
          sku: target.sku,
          quantity: target.expected,
          dryRun: true,
          reservation: true,
          leadTimeBusinessDays: target.leadTimeBusinessDays,
          restockDate: target.restockDate
        });
        validationPreview = {
          httpStatus: preview.httpStatus,
          ok: preview.ok,
          bodyOk: preview.body?.ok === true,
          dryRun: preview.body?.dryRun === true,
          operation: preview.body?.operation || null,
          availabilityPreview: preview.body?.availabilityPreview || null,
          status: preview.body?.result?.status || null,
          submissionId: preview.body?.result?.submissionId || null,
          issues: preview.body?.result?.issues || []
        };
        readyForLiveApproval = previewValid(preview);
      }

      const allNonTargetStable = rows
        .filter(x => x.sku !== target.sku)
        .every(x => x.action === "NO_CHANGE" && x.ordersGate.ok === true && Number(x.ordersGate.totalMatchingOpenQty || 0) === 0);

      console.log(`G83_REPLACEMENT_INVENTORY_HANDOFF_PREFLIGHT=${JSON.stringify({
        status: readyForLiveApproval && allNonTargetStable
          ? "READY_FOR_EXPLICIT_LIVE_APPROVAL"
          : "REVIEW_REQUIRED",
        moduleVersion: VERSION,
        ssotSnapshot: {
          source: "03_EC連携用在庫 + 06_EC SKUマッピング",
          sourceAggregateTimestamp: "2026/09/10 6:32:13",
          poolId: "POOL-G83-11G",
          poolSellableObserved: 21,
          safetyStock: 2,
          unallocatedOrders: 1,
          replacement256Expected: 18,
          replacement256ReservationLeadDays: 3,
          replacement256RestockDate: "2026-09-15",
          replacement1tbExpected: 0
        },
        rows,
        validationPreview,
        readyForLiveApproval,
        allNonTargetStable,
        liveAllowed: false,
        liveBlockedReason: "EXPLICIT_USER_LIVE_APPROVAL_REQUIRED",
        amazonInventoryWrites: 0,
        priceWrites: 0,
        b2bWrites: 0,
        adsWrites: 0,
        yahooWrites: 0,
        variationWrites: 0,
        contentWrites: 0
      })}`);
    } catch (error) {
      console.error(`G83_REPLACEMENT_INVENTORY_HANDOFF_PREFLIGHT_ERROR=${JSON.stringify({
        moduleVersion: VERSION,
        error: error?.message || String(error),
        liveAllowed: false,
        amazonInventoryWrites: 0,
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

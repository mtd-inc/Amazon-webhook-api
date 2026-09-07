import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const ROUTE = "/amazon/listing/s73-variation-validation-preview-trigger-5e44fbc701b248c8";
const TARGET_ROUTE = "/amazon/listing/s73-variation-validation-preview";
const originalListen = express.application.listen;
let consumed = false;

async function handler(_req, res) {
  try {
    if (consumed) return res.status(409).json({ ok:false, error:"ONE_TIME_TRIGGER_ALREADY_CONSUMED" });
    const secret = String(process.env.AMAZON_STOCK_API_SECRET || "").trim();
    if (!secret) return res.status(503).json({ ok:false, error:"AMAZON_STOCK_API_SECRET_MISSING" });
    consumed = true;
    const port = String(process.env.PORT || "10000");
    const r = await fetch(`http://127.0.0.1:${port}${TARGET_ROUTE}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-secret": secret,
      },
      body: JSON.stringify({
        dryRun: true,
        sourceSku: "7X-725F-2ZML",
        targetChildSku: "s73-hs-i5-11g-16gb-ssd512"
      }),
    });
    const text = await r.text();
    return res.status(r.status).type("application/json").send(text);
  } catch (err) {
    return res.status(500).json({ ok:false, error:err?.message || String(err) });
  }
}

express.application.listen = function s73VariationPreviewOneTimeGetTriggerListen(...args) {
  const exists = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!exists) this.get(ROUTE, handler);
  return originalListen.apply(this, args);
};

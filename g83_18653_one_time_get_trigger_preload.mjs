import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const ROUTE = "/amazon/listing/g83-18653-approved-batch-live-trigger-c54b1a2976825d2c";
const BATCH_ROUTE = "/amazon/listing/g83-18653-approved-batch-live";
const originalListen = express.application.listen;
let consumed = false;

async function handler(req, res) {
  try {
    if (consumed) return res.status(409).json({ ok:false, error:"ONE_TIME_TRIGGER_ALREADY_CONSUMED" });
    const secret = String(process.env.G83_18653_ONE_TIME_LIVE_SECRET || "").trim();
    if (!secret) return res.status(503).json({ ok:false, error:"ONE_TIME_LIVE_SECRET_DISABLED" });
    consumed = true;

    const port = String(process.env.PORT || "10000");
    const r = await fetch(`http://127.0.0.1:${port}${BATCH_ROUTE}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-g83-one-time-secret": secret,
      },
      body: JSON.stringify({ approval: "LIVE_APPROVED_20260907" }),
    });
    const text = await r.text();
    res.status(r.status).type("application/json").send(text);
  } catch (err) {
    res.status(500).json({ ok:false, error:err?.message || String(err) });
  }
}

express.application.listen = function g8318653OneTimeGetTriggerListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.get(ROUTE, handler);
  return originalListen.apply(this, args);
};

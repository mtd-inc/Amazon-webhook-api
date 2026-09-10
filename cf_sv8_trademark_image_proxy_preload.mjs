import express from "express";
import fetch from "node-fetch";

const ROUTE = "/audit/cf-sv8-trademark-image/:id";
const originalListen = express.application.listen;
const IMAGES = Object.freeze({
  "4": "https://m.media-amazon.com/images/I/61oDXQ5ifsL.jpg",
  "5": "https://m.media-amazon.com/images/I/61qG-T4hwAL.jpg",
  "6": "https://m.media-amazon.com/images/I/61CYlfKGk5L.jpg",
});

async function handler(req, res) {
  const url = IMAGES[String(req.params?.id || "")];
  if (!url) return res.status(404).type("text/plain").send("not found");
  try {
    const r = await fetch(url, { method: "GET", headers: { accept: "image/jpeg,image/*" } });
    if (!r.ok) return res.status(502).type("text/plain").send(`upstream ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    res.set("Cache-Control", "no-store");
    res.set("Content-Type", r.headers.get("content-type") || "image/jpeg");
    return res.status(200).send(buf);
  } catch (e) {
    return res.status(500).type("text/plain").send(String(e?.message || e));
  }
}

express.application.listen = function cfSv8TrademarkImageProxyListen(...args) {
  const already = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!already) this.get(ROUTE, handler);
  return originalListen.apply(this, args);
};

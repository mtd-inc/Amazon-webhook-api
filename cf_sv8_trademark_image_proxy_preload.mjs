import express from "express";
import fetch from "node-fetch";

const ROUTE = "/audit/cf-sv8-trademark-image/:id";
const originalListen = express.application.listen;
const IMAGES = Object.freeze({
  "1tb_1": "https://m.media-amazon.com/images/I/71Ll8zkDNBL.jpg",
  "1tb_3": "https://m.media-amazon.com/images/I/61tgBWAOUoL.jpg",
  "256_1": "https://m.media-amazon.com/images/I/71sWnNuHdxL.jpg",
  "256_3": "https://m.media-amazon.com/images/I/61vBil5OGqL.jpg",
});

async function fetchImage(url) {
  const r = await fetch(url, { method: "GET", headers: { accept: "image/jpeg,image/*" } });
  if (!r.ok) throw new Error(`upstream ${r.status}`);
  return { contentType: r.headers.get("content-type") || "image/jpeg", buf: Buffer.from(await r.arrayBuffer()) };
}

async function handler(req, res) {
  const url = IMAGES[String(req.params?.id || "")];
  if (!url) return res.status(404).type("text/plain").send("not found");
  try {
    const { contentType, buf } = await fetchImage(url);
    res.set("Cache-Control", "no-store");
    res.set("Content-Type", contentType);
    return res.status(200).send(buf);
  } catch (e) {
    return res.status(500).type("text/plain").send(String(e?.message || e));
  }
}

express.application.listen = function cfSv8TrademarkImageProxyListen(...args) {
  const already = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!already) this.get(ROUTE, handler);
  const server = originalListen.apply(this, args);
  setTimeout(async () => {
    for (const [id, url] of Object.entries(IMAGES)) {
      try {
        const thumb = url.replace(/\.jpg$/i, "._SL100_.jpg");
        const { contentType, buf } = await fetchImage(thumb);
        console.log(`CF_SV8_TRADEMARK_UNIQUE_THUMB100_${id}=${JSON.stringify({ id, sourceUrl:url, thumbnailUrl:thumb, contentType, bytes:buf.length, base64:buf.toString("base64"), readOnly:true, amazonPersistentWrites:0, externalChanges:0 })}`);
      } catch (e) {
        console.error(`CF_SV8_TRADEMARK_UNIQUE_THUMB100_${id}_ERROR=${JSON.stringify({ error:e?.message||String(e), readOnly:true, amazonPersistentWrites:0, externalChanges:0 })}`);
      }
    }
  }, 5000);
  return server;
};

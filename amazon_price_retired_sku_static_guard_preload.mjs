import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "AMAZON_PRICE_RETIRED_SKU_GUARD_V1_0_0";
const SELF = "amazon_price_retired_sku_static_guard_preload.mjs";
const RETIRED = Object.freeze([
  "F7-AF7O-IGX5", "B0FN3KQFR3",
  "9K-D0RA-4R8V", "B0FPC4R7ZG",
]);
const PRICE_MODULE = /(price|min_points|b2b|offer)/i;
const root = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const start = String(pkg?.scripts?.start || "");
const imports = [...start.matchAll(/--import \.\/([^\s]+)/g)].map(m => m[1]);
const activePriceModules = imports.filter(f => f !== SELF && PRICE_MODULE.test(f));
const violations = [];
for (const file of activePriceModules) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) continue;
  const text = fs.readFileSync(full, "utf8");
  for (const token of RETIRED) if (text.includes(token)) violations.push({ file, token });
}
if (violations.length) throw new Error(`${VERSION}: RETIRED_PRICE_TARGET_REFERENCE ${JSON.stringify(violations)}`);
console.log(`${VERSION}: PASS activePriceModules=${activePriceModules.length}`);

/**
 * CF-SV7 cost-basis contract for reviewing the bound GAS V119/V120 code.
 * PURE AND NON-PRODUCTION: never imported by server, never writes to Amazon,
 * Sheets, Yahoo, or Google Apps Script. Port the decision table only after the
 * actual Apps Script source and triggers have been reviewed.
 *
 * Price SSOT: 47_価格算定代表原価SSOT, row 6 (index 0-based by array).
 * A = sku, B = method, F = override, G = representative, H = high cost,
 * I = total, T = status, V = algorithm specification.
 */
export const TARGET_SKU = "cf-sv7-i5-8gb-ssd256";
export const TARGET_SELLER_SKU = "cf-sv7-i5-8gb-ssd256";
export const TARGET_ASIN = "B0GH73M1BH";
export const PENDING = "MANUAL_AVERAGE_PENDING_GAS_ENGINE_VERIFY";
export const ACTIVE = "MANUAL_OVERRIDE_ACTIVE";
export const METHOD = "ON_HAND_AVERAGE_MANUAL_OVERRIDE";
const finite = n => typeof n === "number" && Number.isFinite(n) && n > 0;
const toNumber = raw => raw === "" || raw === null || raw === undefined ? null : Number(raw);

export function assessAverageCostOverride({sku, row, physicalCosts}) {
  const blocks = [];
  if(sku !== TARGET_SKU || !Array.isArray(row) || row[0] !== TARGET_SKU)
    return {decision:"BLOCK_SKU_MISMATCH",canUseForLiveCandidate:false,blocks:["SKU_MISMATCH"]};
  const method = String(row[1]||"");
  const manual = toNumber(row[5]);
  const representative = toNumber(row[6]);
  const highest = toNumber(row[7]);
  const total = toNumber(row[8]);
  const state = String(row[19]||"");
  if(method !== METHOD) blocks.push("METHOD_NOT_MANUAL_ON_HAND_AVERAGE");
  if(!finite(manual)||!finite(representative)||manual!==representative)
    blocks.push("MANUAL_REPRESENTATIVE_NOT_EQUAL_OR_INVALID");
  if(!Array.isArray(physicalCosts)||physicalCosts.length !== total||total<1||
     physicalCosts.some(x=>!finite(x)))blocks.push("PHYSICAL_COST_EVIDENCE_INCOMPLETE");
  const computed = Array.isArray(physicalCosts)&&physicalCosts.length>0&&physicalCosts.every(finite)
    ? Math.round(physicalCosts.reduce((a,b)=>a+b,0)/physicalCosts.length)
    : null;
  const actualHighest = computed!==null ? Math.max(...physicalCosts) : null;
  if(computed!==manual)blocks.push("ON_HAND_MEAN_NOT_EQUAL");
  if(actualHighest!==highest)blocks.push("AUDIT_HIGH_COST_NOT_EQUAL");
  if(state!==ACTIVE && state!==PENDING)blocks.push("UNRECOGNIZED_MANUAL_STATE");
  if(state===PENDING)blocks.push("GAS_ENGINE_BEHAVIOR_UNVERIFIED");
  const canUseForLiveCandidate = blocks.length===0;
  return {
    decision:canUseForLiveCandidate?"MANUAL_AVERAGE_VERIFIED":
      state===PENDING?"BLOCKED_PENDING_GAS_ENGINE_VERIFY":"BLOCKED_COST_BASIS_INVALID",
    canUseForLiveCandidate,sku,manual,representative,actualHighest,
    sampledUnits:Array.isArray(physicalCosts)?physicalCosts.length:null,
    computedAverage:computed,blocks
  };
}

export function assessCandidateReadiness({
  sku, sellerSku, asin, candidateCost, costAssessment, ssotRefreshed,
  requiredMinSource, observedSellerMinimum
}) {
  const blocks = [];
  if(sku!==TARGET_SKU || sellerSku!==TARGET_SELLER_SKU || asin!==TARGET_ASIN)
    blocks.push("EXACT_SKU_ASIN_MISMATCH");
  if(!costAssessment?.canUseForLiveCandidate)blocks.push("COST_BASIS_NOT_VERIFIED");
  if(!ssotRefreshed || requiredMinSource!=="EXACT_SELLER_SKU_ASIN")
    blocks.push("MIN_PRICE_SSOT_NOT_FRESH");
  if(!finite(observedSellerMinimum))blocks.push("SELLER_MINIMUM_NOT_OBSERVED");
  if(costAssessment?.representative!==candidateCost)blocks.push("CANDIDATE_COST_DRIFT");
  return {decision:blocks.length?"BLOCKED":"READY_FOR_READ_ONLY_PRICE_REVIEW",blocks,
    externalChanges:0,livePermission:false};
}

export function estimateContribution(price, cost, {
  feeRate=0.10, points=268, shippingPacking=1250, adsPerOrder=2000
}={}) {
  if(!finite(price)||!finite(cost)||feeRate<0||feeRate>=1||
    [points,shippingPacking,adsPerOrder].some(x=>!Number.isFinite(x)||x<0))
    throw Error("INVALID_ECONOMICS_INPUT");
  return Math.round(price*(1-feeRate)-cost-points-shippingPacking-adsPerOrder);
}

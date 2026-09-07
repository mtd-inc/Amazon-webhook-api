import fetch from "node-fetch";

let fired=false;
setTimeout(async()=>{
  if(fired)return;fired=true;
  try{
    const port=String(process.env.PORT||"10000");
    const secret=String(process.env.AMAZON_STOCK_API_SECRET||"").trim();
    if(!secret)throw new Error("AMAZON_STOCK_API_SECRET missing");
    const r=await fetch(`http://127.0.0.1:${port}/amazon/listing/s73-variation-live-package-retry-v2`,{
      method:"POST",
      headers:{"content-type":"application/json","x-api-secret":secret},
      body:JSON.stringify({confirmLive:"CONFIRM_S73_VARIATION_LIVE_PACKAGE_V2_20260907"})
    });
    const text=await r.text();
    console.log(`S73_VARIATION_LIVE_PACKAGE_V2_TRIGGER_RESULT=${text}`);
  }catch(e){
    console.error(`S73_VARIATION_LIVE_PACKAGE_V2_TRIGGER_ERROR=${e?.message||String(e)}`);
  }
},7000);

#!/usr/bin/env bun
// gemini-gen.js — Single image generation via Gemini Web + pure CDP
// Usage: bun gemini-gen.js <prompt_text_or_file> <output_path> [options]

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
function flag(name, def) { const i = args.indexOf("--"+name); if(i===-1) return def; const v=args[i+1]; args.splice(i,2); return v; }
function hasFlag(name) { const i = args.indexOf("--"+name); if(i===-1) return false; args.splice(i,1); return true; }

const CDP_PORT = parseInt(flag("port","9222"));
const USER = flag("user","1");
const NEW_CHAT = hasFlag("new-chat");
const MIN_WAIT = parseInt(flag("min-wait","20"));
const DL_WAIT = parseInt(flag("dl-wait","20"));
const promptInput = args[0], outputPath = args[1];

if (!promptInput||!outputPath) { console.error("Usage: bun gemini-gen.js <prompt_or_file> <output> [--port 9222] [--user 1] [--new-chat]"); process.exit(1); }
const prompt = fs.existsSync(promptInput) ? fs.readFileSync(promptInput,"utf-8").trim() : promptInput;
const sleep = ms => new Promise(r=>setTimeout(r,ms));

// ─── CDP ─────────────────────────────────────────────────────
let ws, bws, nextId=1, bNextId=1;
async function connect() {
  // Browser-level WebSocket (for Browser.setDownloadBehavior)
  const ver = await (await fetch(`http://localhost:${CDP_PORT}/json/version`)).json();
  bws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise(r=>(bws.onopen=r));

  const tabs = await (await fetch(`http://localhost:${CDP_PORT}/json/list`)).json();
  // Match Gemini app tabs specifically (not glic, service workers, rotate cookies, etc.)
  const isGeminiApp = t => /gemini\.google\.com\/(u\/\d+\/)?app/.test(t.url);
  // Prefer tabs matching the target user
  let tab = tabs.find(t=>isGeminiApp(t) && t.url.includes(`/u/${USER}/`))
         || tabs.find(t=>isGeminiApp(t));
  if (!tab) {
    await fetch(`http://localhost:${CDP_PORT}/json/new?https://gemini.google.com/u/${USER}/app?hl=en`,{method:"PUT"});
    await sleep(4000);
    const tabs2 = await (await fetch(`http://localhost:${CDP_PORT}/json/list`)).json();
    tab = tabs2.find(t=>isGeminiApp(t));
    if (!tab) throw new Error("Cannot open Gemini");
  }
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise(r=>(ws.onopen=r));
}
function bsend(method,params={}) {
  const id=bNextId++;
  return new Promise((resolve,reject)=>{
    const t=setTimeout(()=>reject(new Error("btimeout:"+method)),30000);
    bws.addEventListener("message",function h(e){const d=JSON.parse(e.data);if(d.id===id){clearTimeout(t);bws.removeEventListener("message",h);resolve(d);}});
    bws.send(JSON.stringify({id,method,params}));
  });
}
function send(method,params={}) {
  const id=nextId++;
  return new Promise((resolve,reject)=>{
    const t=setTimeout(()=>reject(new Error("timeout:"+method)),30000);
    ws.addEventListener("message",function h(e){const d=JSON.parse(e.data);if(d.id===id){clearTimeout(t);ws.removeEventListener("message",h);resolve(d);}});
    ws.send(JSON.stringify({id,method,params}));
  });
}
async function ev(expr) { const r=await send("Runtime.evaluate",{expression:expr,returnByValue:true,awaitPromise:true}); return r.result?.result?.value; }

function isValidImage(p) { try { const b=fs.readFileSync(p); return b.length>100000&&(b[0]===0x89&&b[1]===0x50||b[0]===0xFF&&b[1]===0xD8); } catch{return false;} }

// ─── Actions ─────────────────────────────────────────────────
async function navigate(url) { await send("Page.navigate",{url}); await sleep(4000); }
async function dismissPopups() { await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>/Acknowledge|Got it|Accept/i.test(b.innerText||b.getAttribute('aria-label')||''));if(b){b.click();return 1}return 0})()`); await sleep(500); }
async function getDL() { return await ev(`[...document.querySelectorAll('button')].filter(b=>(b.getAttribute('aria-label')||'').includes('Download full size')).length`); }
async function hasStop() { return await ev(`[...document.querySelectorAll('button')].some(b=>(b.getAttribute('aria-label')||'').includes('Stop response'))`); }

async function sendPrompt(text) {
  await ev(`(()=>{const e=document.querySelector('.ql-editor,[contenteditable="true"]');if(e)e.focus()})()`);
  await sleep(200);
  await send("Input.insertText",{text});
  await sleep(500);
  const sent = await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>(b.getAttribute('aria-label')||'').includes('Send message'));if(b&&!b.disabled){b.click();return true}return false})()`);
  if (!sent) { await send("Input.dispatchKeyEvent",{type:"keyDown",key:"Enter",code:"Enter",windowsVirtualKeyCode:13}); await send("Input.dispatchKeyEvent",{type:"keyUp",key:"Enter",code:"Enter",windowsVirtualKeyCode:13}); }
}

async function downloadImage(idx, outPath) {
  const dir = path.resolve(path.dirname(outPath)); // ALWAYS absolute
  fs.mkdirSync(dir,{recursive:true});

  for (let attempt=0; attempt<3; attempt++) {
    // Set download behavior on BOTH browser-level AND page-level
    await bsend("Browser.setDownloadBehavior",{behavior:"allow",downloadPath:dir,eventsEnabled:true});
    await send("Page.setDownloadBehavior",{behavior:"allow",downloadPath:dir});
    await sleep(500);
    const before = new Set(fs.readdirSync(dir).filter(f=>/\.(png|jpe?g|webp)$/i.test(f) && !f.startsWith('.') && !f.endsWith('.crdownload')));

    // Scroll first, then click separately (like dl2.js)
    await ev(`(()=>{const b=[...document.querySelectorAll('button')].filter(b=>(b.getAttribute('aria-label')||'').includes('Download full size'));if(${idx}<b.length){b[${idx}].scrollIntoView({block:'center'});return true}return false})()`);
    await sleep(500);
    await ev(`(()=>{const b=[...document.querySelectorAll('button')].filter(b=>(b.getAttribute('aria-label')||'').includes('Download full size'));if(${idx}<b.length){b[${idx}].click();return true}return false})()`);

    for (let i=0; i<DL_WAIT*2; i++) {
      await sleep(500);
      const after = fs.readdirSync(dir).filter(f=>/\.(png|jpe?g|webp)$/i.test(f) && !f.startsWith('.') && !f.endsWith('.crdownload'));
      const nf = after.filter(f=>!before.has(f));
      if (nf.length>0) {
        nf.sort((a,b)=>fs.statSync(path.join(dir,b)).mtimeMs-fs.statSync(path.join(dir,a)).mtimeMs);
        const src=path.join(dir,nf[0]);
        let last=-1; for(let j=0;j<10;j++){const sz=fs.statSync(src).size;if(sz===last)break;last=sz;await sleep(300);}
        if (isValidImage(src)) {
          if(src!==outPath){fs.copyFileSync(src,outPath);fs.unlinkSync(src);}
          return fs.statSync(outPath).size;
        }
      }
    }
    if (attempt<2) console.log(`  ⚠️ DL retry ${attempt+2}...`);
  }
  throw new Error("Download failed");
}

// ─── Main ────────────────────────────────────────────────────
async function main() {
  console.log(`🎨 Generating → ${path.basename(outputPath)}`);
  await connect();

  if (NEW_CHAT) await navigate(`https://gemini.google.com/u/${USER}/app?hl=en`);
  await dismissPopups();

  const mode = await ev(`(()=>{const b=document.querySelector('button[aria-label*="mode picker"]')||[...document.querySelectorAll('button')].find(b=>/^(Fast|Pro)$/i.test(b.innerText?.trim()));return b?b.innerText?.trim():'PRO'})()`);
  console.log(`  Mode: ${mode}`);

  const prevDL = await getDL();
  console.log(`  Existing: ${prevDL} images`);

  await sendPrompt(prompt);
  console.log("  📤 Sent");

  await sleep(MIN_WAIT*1000);
  let dlReady=false, dlReadyAt=0;
  for (let i=0;i<120;i++) {
    const dl=await getDL(), stop=await hasStop();
    if (dl>prevDL && !dlReady) { dlReady=true; dlReadyAt=i; console.log(`  🖼️ Image appeared (${MIN_WAIT+i*2}s, DL: ${prevDL}→${dl})`); }
    // Break if: (a) image ready + stop gone, or (b) image ready + 15s buffer passed
    if (dl>prevDL && (!stop || (dlReady && i-dlReadyAt>=8))) { console.log(`  ✅ Ready (${MIN_WAIT+i*2}s, DL: ${prevDL}→${dl}, stop=${stop?1:0})`); break; }
    if (i%5===0&&i>0) console.log(`  ${MIN_WAIT+i*2}s (stop=${stop?1:0}, dl=${dl}/${prevDL+1})`);
    await sleep(2000);
  }

  const sz = await downloadImage(await getDL()-1, outputPath);
  console.log(`  ✅ ${path.basename(outputPath)} — ${Math.round(sz/1024)}KB`);
  ws.close(); bws.close();
  console.log("🏁 Done");
}

main().catch(e=>{console.error("❌",e.message);if(ws)ws.close();if(bws)bws.close();process.exit(1);});

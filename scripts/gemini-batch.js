#!/usr/bin/env bun
// gemini-batch.js — Batch: multiple prompts in ONE conversation (pure CDP)
// Usage: bun gemini-batch.js <prompts_dir> <output_dir> [options]

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
function flag(name,def){const i=args.indexOf("--"+name);if(i===-1)return def;const v=args[i+1];args.splice(i,2);return v;}
const CDP_PORT=parseInt(flag("port","9222")), USER=flag("user","1");
const MIN_WAIT=parseInt(flag("min-wait","20")), DL_WAIT=parseInt(flag("dl-wait","20"));
const NOTIFY_CMD=flag("notify","");
const PROMPTS_DIR=args[0], OUTPUT_DIR=args[1];

if(!PROMPTS_DIR||!OUTPUT_DIR){console.error("Usage: bun gemini-batch.js <prompts_dir> <output_dir> [options]");process.exit(1);}
const promptFiles=fs.readdirSync(PROMPTS_DIR).filter(f=>/\.(txt|md)$/.test(f)).sort();
if(!promptFiles.length){console.error("No prompt files");process.exit(1);}
console.log(`📋 Found ${promptFiles.length} prompts in ${PROMPTS_DIR}`);
fs.mkdirSync(OUTPUT_DIR,{recursive:true});

const sleep=ms=>new Promise(r=>setTimeout(r,ms));

// ─── CDP ─────────────────────────────────────────────────────
let ws,bws,nextId=1,bNextId=1;
function send(method,params={}){const id=nextId++;return new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error("timeout:"+method)),30000);ws.addEventListener("message",function h(e){const d=JSON.parse(e.data);if(d.id===id){clearTimeout(t);ws.removeEventListener("message",h);resolve(d);}});ws.send(JSON.stringify({id,method,params}));});}
function bsend(method,params={}){const id=bNextId++;return new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error("btimeout:"+method)),30000);bws.addEventListener("message",function h(e){const d=JSON.parse(e.data);if(d.id===id){clearTimeout(t);bws.removeEventListener("message",h);resolve(d);}});bws.send(JSON.stringify({id,method,params}));});}
async function ev(expr){const r=await send("Runtime.evaluate",{expression:expr,returnByValue:true,awaitPromise:true});return r.result?.result?.value;}
function isValid(p){try{const b=fs.readFileSync(p);return b.length>100000&&(b[0]===0x89&&b[1]===0x50||b[0]===0xFF&&b[1]===0xD8);}catch{return false;}}

async function getDL(){return await ev(`[...document.querySelectorAll('button')].filter(b=>(b.getAttribute('aria-label')||'').includes('Download full size')).length`);}
async function hasStop(){return await ev(`[...document.querySelectorAll('button')].some(b=>(b.getAttribute('aria-label')||'').includes('Stop response'))`);}

async function sendPrompt(text){
  await ev(`(()=>{const e=document.querySelector('.ql-editor,[contenteditable="true"]');if(e)e.focus()})()`);
  await sleep(200);
  await send("Input.insertText",{text});
  await sleep(500);
  const sent=await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>(b.getAttribute('aria-label')||'').includes('Send message'));if(b&&!b.disabled){b.click();return true}return false})()`);
  if(!sent){await send("Input.dispatchKeyEvent",{type:"keyDown",key:"Enter",code:"Enter",windowsVirtualKeyCode:13});await send("Input.dispatchKeyEvent",{type:"keyUp",key:"Enter",code:"Enter",windowsVirtualKeyCode:13});}
}

async function downloadImage(idx,outPath){
  const dir=path.resolve(path.dirname(outPath));
  for(let attempt=0;attempt<3;attempt++){
    await bsend("Browser.setDownloadBehavior",{behavior:"allow",downloadPath:dir,eventsEnabled:true});
    await send("Page.setDownloadBehavior",{behavior:"allow",downloadPath:dir});
    await sleep(500);
    const before=new Set(fs.readdirSync(dir).filter(f=>/\.(png|jpe?g|webp)$/i.test(f) && !f.startsWith('.') && !f.endsWith('.crdownload')));
    await ev(`(()=>{const b=[...document.querySelectorAll('button')].filter(b=>(b.getAttribute('aria-label')||'').includes('Download full size'));if(${idx}<b.length){b[${idx}].scrollIntoView({block:'center'});return true}return false})()`);
    await sleep(500);
    await ev(`(()=>{const b=[...document.querySelectorAll('button')].filter(b=>(b.getAttribute('aria-label')||'').includes('Download full size'));if(${idx}<b.length){b[${idx}].click();return true}return false})()`);
    for(let i=0;i<DL_WAIT*2;i++){
      await sleep(500);
      const after=fs.readdirSync(dir).filter(f=>/\.(png|jpe?g|webp)$/i.test(f) && !f.startsWith('.') && !f.endsWith('.crdownload'));
      const nf=after.filter(f=>!before.has(f));
      if(nf.length>0){
        nf.sort((a,b)=>fs.statSync(path.join(dir,b)).mtimeMs-fs.statSync(path.join(dir,a)).mtimeMs);
        const src=path.join(dir,nf[0]);
        let last=-1;for(let j=0;j<10;j++){const sz=fs.statSync(src).size;if(sz===last)break;last=sz;await sleep(300);}
        if(isValid(src)){if(src!==outPath){fs.copyFileSync(src,outPath);fs.unlinkSync(src);}return fs.statSync(outPath).size;}
      }
    }
    if(attempt<2)console.log(`  ⚠️ DL retry ${attempt+2}...`);
  }
  throw new Error("Download failed");
}

// ─── Main ────────────────────────────────────────────────────
async function main(){
  // Browser-level WebSocket
  const ver=await(await fetch(`http://localhost:${CDP_PORT}/json/version`)).json();
  bws=new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise(r=>(bws.onopen=r));

  const tabs=await(await fetch(`http://localhost:${CDP_PORT}/json/list`)).json();
  const isGeminiApp=t=>/gemini\.google\.com\/(u\/\d+\/)?app/.test(t.url);
  let tab=tabs.find(t=>isGeminiApp(t)&&t.url.includes(`/u/${USER}/`))||tabs.find(t=>isGeminiApp(t));
  if(!tab){await fetch(`http://localhost:${CDP_PORT}/json/new?https://gemini.google.com/u/${USER}/app?hl=en`,{method:"PUT"});await sleep(4000);const t2=await(await fetch(`http://localhost:${CDP_PORT}/json/list`)).json();tab=t2.find(t=>isGeminiApp(t));}
  if(!tab)throw new Error("No Gemini tab");
  ws=new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise(r=>(ws.onopen=r));

  // New chat
  await send("Page.navigate",{url:`https://gemini.google.com/u/${USER}/app?hl=en`});
  await sleep(4000);
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>/Acknowledge|Got it/i.test(b.innerText||''));if(b)b.click()})()`);
  await sleep(500);

  // Verify Pro
  const mode=await ev(`(()=>{const b=document.querySelector('button[aria-label*="mode picker"]')||[...document.querySelectorAll('button')].find(b=>/^(Fast|Pro)$/i.test(b.innerText?.trim()));return b?b.innerText?.trim():'PRO'})()`);
  if(mode==="Fast"){
    await ev(`(()=>{const b=document.querySelector('button[aria-label*="mode picker"]')||[...document.querySelectorAll('button')].find(b=>b.innerText?.trim()==='Fast');if(b)b.click()})()`);
    await sleep(1000);
    await ev(`(()=>{const i=[...document.querySelectorAll('[role="menuitemradio"]')].find(i=>i.innerText?.includes('Pro'));if(i)i.click()})()`);
    await sleep(1000);
  }
  console.log("✅ Pro mode");

  const results=[];
  let prevDL=0;

  for(let idx=0;idx<promptFiles.length;idx++){
    const pFile=promptFiles[idx];
    const baseName=pFile.replace(/\.(txt|md)$/,"");
    const outFile=path.join(OUTPUT_DIR,baseName+".png");
    const text=fs.readFileSync(path.join(PROMPTS_DIR,pFile),"utf-8").trim();

    console.log(`\n===== 🎨 [${idx+1}/${promptFiles.length}] ${baseName} =====`);
    await sendPrompt(text);
    console.log("  📤 Sent");

    // Wait
    await sleep(MIN_WAIT*1000);
    let ready=false;
    for(let i=0;i<120;i++){
      const dl=await getDL(),stop=await hasStop();
      if(dl>prevDL&&!stop){
        console.log(`  ✅ Ready (${MIN_WAIT+i*2}s, DL: ${prevDL}→${dl})`);
        const sz=await downloadImage(dl-1,outFile);
        console.log(`  ✅ ${baseName} — ${Math.round(sz/1024)}KB`);
        results.push({name:baseName,ok:true,size:sz});
        prevDL=dl;
        ready=true;
        break;
      }
      if(i%5===0&&i>0)console.log(`  ${MIN_WAIT+i*2}s (stop=${stop?1:0}, dl=${dl}/${prevDL+1})`);
      await sleep(2000);
    }
    if(!ready){console.log(`  ❌ ${baseName} timeout`);results.push({name:baseName,ok:false});}

    if(NOTIFY_CMD){try{Bun.spawnSync(["sh","-c",`${NOTIFY_CMD} "${baseName}" "${outFile}" ${idx+1} ${promptFiles.length}`]);}catch{}}
  }

  const ok=results.filter(r=>r.ok).length;
  console.log(`\n===== 📊 Result: ${ok}/${promptFiles.length} =====`);
  results.forEach(r=>console.log(`${r.ok?"✅":"❌"} ${r.name}.png`));
  ws.close();bws.close();
}

main().catch(e=>{console.error("❌",e.message);if(ws)ws.close();if(bws)bws.close();process.exit(1);});

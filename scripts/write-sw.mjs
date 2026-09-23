import { readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const assets = (await readdir("dist/assets"))
  .filter((n) => /\.(js|css)$/.test(n))
  .map((n) => "/assets/" + n);
const version = createHash("sha256")
  .update("offline-shell-v2")
  .update(await readFile("scripts/write-sw.mjs"))
  .update(await readFile("dist/index.html"))
  .update(await readFile("dist/THIRD_PARTY.txt"))
  .update(await readFile("package-lock.json"))
  .digest("hex")
  .slice(0, 12);
const urls = [
  "/",
  "/index.html",
  "/favicon.svg",
  "/THIRD_PARTY.txt",
  "/realtime-player.js",
  ...assets,
];
await writeFile(
  "dist/sw.js",
  `const CACHE='listen-shell-${version}';
const CORE=${JSON.stringify(urls)};
self.addEventListener('install',event=>event.waitUntil((async()=>{
 const cache=await caches.open(CACHE);
 for(const url of CORE){
  const response=await fetch(new Request(url,{cache:'reload'}));
  if(!response.ok || (/\\.(js|css)$/.test(url) && (response.headers.get('content-type')||'').includes('text/html')))throw new Error('Invalid offline asset: '+url);
  await cache.put(url,response);
 }
 await self.skipWaiting();
})()));
// Keep older shells so existing tabs can finish loading their own hashed scripts.
// Activation never reloads a live page or interrupts synthesis.
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('fetch',event=>{
 const request=event.request; const url=new URL(request.url);
 if(request.method!=='GET'||url.origin!==self.location.origin)return;
 // Audition manifests evolve during generation; media range responses must not
 // enter the generic shell cache. The audition bundle remains plain static files.
 if(url.pathname.startsWith('/auditions/') || url.pathname.startsWith('/models/qwen-webgpu/') || url.pathname==='/realtime-results.json')return;
 event.respondWith((async()=>{
  const cache=await caches.open(CACHE);
  if(request.mode==='navigate'){
   try{const live=await fetch(request);if(live.ok)return live;}catch{}
   return await cache.match('/index.html') || Response.error();
  }
  const saved=await cache.match(request) || await caches.match(request);if(saved)return saved;
  const response=await fetch(request);
  if(response.ok && !(/\\.(js|css|wasm|mjs)$/.test(url.pathname) && (response.headers.get('content-type')||'').includes('text/html')))await cache.put(request,response.clone());
  return response;
 })());
});
`,
);
console.log("Offline shell generated:", version);

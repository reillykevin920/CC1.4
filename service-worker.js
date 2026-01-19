
// NOTE: GitHub Pages PWAs fail "install" if cache.addAll includes any missing file.
// This service worker builds the offline cache *only* from actual manifests shipped
// with the site, ensuring first-load-online results in full offline search/reader.
const CACHE_NAME = "civic-compass-v2";

const CORE = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./assets/styles.css",
  "./assets/app.js",

  // App icons
  "./assets/icons/apple-touch-icon.png",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png",
  "./assets/icons/favicon16.ico",
  "./assets/icons/favicon32.ico",
  "./assets/icons/favicon-48.ico",

  // Data + manifests
  "./data/cross_corpus_index.json",
  "./data/categories.json",
  "./data/concepts.json",
  "./data/inspector_terms.json",
  "./data/inspector_profile.json",
  "./data/dcs_manifest.json",
  "./data/brc_manifest.json",
  "./data/title9_manifest.json",
];

async function safeJson(url) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch (_) {
    return null;
  }
}

async function buildAssetList() {
  const assets = new Set(CORE);

  const [dcs, brc, t9] = await Promise.all([
    safeJson("./data/dcs_manifest.json"),
    safeJson("./data/brc_manifest.json"),
    safeJson("./data/title9_manifest.json"),
  ]);

  if (dcs && Array.isArray(dcs.chapters)) {
    for (const ch of dcs.chapters) {
      if (ch && ch.file) assets.add(`./data/dcs/${String(ch.file).split('/').pop()}`);
    }
  }

  if (brc && Array.isArray(brc.titles)) {
    for (const t of brc.titles) {
      if (t && t.file) assets.add(`./data/brc/${String(t.file).split('/').pop()}`);
    }
  }

  if (t9 && Array.isArray(t9.chapters)) {
    for (const ch of t9.chapters) {
      if (ch && ch.file) assets.add(`./data/title9/${String(ch.file).split('/').pop()}`);
    }
  }

  return [...assets];
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const assets = await buildAssetList();
    await cache.addAll(assets);
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k === CACHE_NAME) ? null : caches.delete(k)));
    self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  event.respondWith((async () => {
    const cached = await caches.match(event.request, {ignoreSearch:true});
    if (cached) return cached;
    try {
      const res = await fetch(event.request);
      return res;
    } catch (e) {
      // Offline fallback: index
      if (event.request.mode === "navigate") {
        const fallback = await caches.match("./index.html");
        if (fallback) return fallback;
      }
      throw e;
    }
  })());
});

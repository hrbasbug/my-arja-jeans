/**
 * Trendyol Marketplace API → products.json + lokal görseller senkronizasyonu.
 *
 * Özellikler:
 *  - productMainId+Renk dedupe (varyantları gruplar, her renge tek listing)
 *  - Image URL değişimi tespit edip eski dosyayı silip yeniden indirir
 *  - Stok=0 ürünleri otomatik gizler
 *  - Yeni ürün rozeti için isNew flag (önceki sync'te yoktu / son 30 gün içinde yaratıldı)
 *  - Fiyat değişimi log'u + commit message için .sync-summary.json
 *
 * GitHub Actions tarafından her 4 saatte bir çalıştırılır.
 * Lokal test:
 *   TRENDYOL_API_KEY=... TRENDYOL_API_SECRET=... TRENDYOL_SUPPLIER_ID=1199692 node _sync-trendyol-api.mjs
 */
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SUPPLIER_ID = process.env.TRENDYOL_SUPPLIER_ID;
const API_KEY     = process.env.TRENDYOL_API_KEY;
const API_SECRET  = process.env.TRENDYOL_API_SECRET;

if (!SUPPLIER_ID || !API_KEY || !API_SECRET) {
  console.error('!! Missing env vars: TRENDYOL_SUPPLIER_ID / TRENDYOL_API_KEY / TRENDYOL_API_SECRET');
  process.exit(1);
}

const auth    = Buffer.from(`${API_KEY}:${API_SECRET}`).toString('base64');
const HEADERS = {
  'Authorization': `Basic ${auth}`,
  'User-Agent':    `${SUPPLIER_ID} - SelfIntegration`,
  'Accept':        'application/json',
};

const IMG_DIR     = path.join(__dirname, 'brand_assets', 'products');
const META_OUT    = path.join(__dirname, 'brand_assets', 'products.json');
const SUMMARY_OUT = path.join(__dirname, 'brand_assets', '.sync-summary.json');
const NEW_PRODUCT_DAYS = 30;

if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true });

// Read previous products to detect changes
let previous = {};
try {
  const prev = JSON.parse(fs.readFileSync(META_OUT, 'utf8'));
  previous = Object.fromEntries(prev.map(p => [p.id, p]));
  console.log(`Loaded ${Object.keys(previous).length} previous products for change detection`);
} catch {
  console.log('No previous products.json — first run');
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: HEADERS }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} for ${url}\n${data.slice(0, 500)}`));
        }
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`JSON parse: ${e.message}\n${data.slice(0,200)}`)); }
      });
    }).on('error', reject);
  });
}

function downloadImage(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.trendyol.com/' } }, (res) => {
      if (res.statusCode !== 200) {
        file.close(); try { fs.unlinkSync(dest); } catch {}
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
    }).on('error', (e) => { file.close(); try { fs.unlinkSync(dest); } catch {} reject(e); });
  });
}

const fmt = (n) => new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

async function fetchAllProducts() {
  const base = `https://apigw.trendyol.com/integration/product/sellers/${SUPPLIER_ID}/products`;
  const all = [];
  for (let page = 0; page < 50; page++) {
    const url = `${base}?page=${page}&size=200`;
    process.stdout.write(`→ Page ${page}... `);
    const res = await fetchJson(url);
    const items = res.content || [];
    all.push(...items);
    console.log(`${items.length} items (running total: ${all.length}/${res.totalElements ?? '?'})`);
    if (page + 1 >= (res.totalPages ?? 0)) break;
  }
  return all;
}

const raw = await fetchAllProducts();

// Filter: only approved + on-sale + has stock
const filtered = raw.filter(p =>
  p.approved && !p.rejected && !p.blacklisted && p.onSale !== false && (p.quantity ?? 0) > 0
);
console.log(`\nTotal raw: ${raw.length}, After approval+stock filter: ${filtered.length}`);

// Dedupe: aynı (productMainId + Renk) tek listing → en yüksek stoklu varyantı temsilci seç
function pickColor(p) {
  const attrs = p.attributes || [];
  const ca = attrs.find(a => a.attributeName === 'Renk' && a.attributeValueId);
  if (ca) return String(ca.attributeValueId);
  const cb = attrs.find(a => a.attributeName === 'Renk');
  if (cb) return String(cb.attributeValue || 'default');
  return 'default';
}

const byListing = new Map();
for (const p of filtered) {
  const main  = p.productMainId || p.productCode || p.id;
  const color = pickColor(p);
  const key   = `${main}|${color}`;
  const existing = byListing.get(key);
  if (!existing) { byListing.set(key, p); continue; }
  const a = p.quantity ?? 0, b = existing.quantity ?? 0;
  if (a > b) { byListing.set(key, p); continue; }
  if (a === b && (p.listPrice ?? Infinity) < (existing.listPrice ?? Infinity)) {
    byListing.set(key, p);
  }
}
const visible = Array.from(byListing.values());
const mainCount = new Set(filtered.map(p => p.productMainId || p.productCode || p.id)).size;
console.log(`Deduped: ${filtered.length} variants → ${visible.length} listings (${mainCount} ana model)`);

// Transform to public shape + flag new/changed
const now = Date.now();
const out = visible.map(p => {
  const publicId = p.productContentId || p.id;
  const id = String(publicId);
  let priceStr = null;
  if (p.salePrice && p.listPrice && p.salePrice < p.listPrice) {
    priceStr = `Sepette${fmt(p.salePrice)} TL${fmt(p.listPrice)} TL`;
  } else if (p.salePrice) {
    priceStr = `${fmt(p.salePrice)} TL`;
  }
  const img = (p.images && p.images[0] && p.images[0].url) || '';
  const prev = previous[id];
  // "Yeni" if previously absent OR created within last NEW_PRODUCT_DAYS
  let isNew = !prev;
  if (!isNew && p.createDateTime) {
    const ageDays = (now - p.createDateTime) / (1000 * 60 * 60 * 24);
    if (ageDays < NEW_PRODUCT_DAYS) isNew = true;
  }
  return {
    id,
    href:      p.productUrl || `https://www.trendyol.com/-p-${publicId}`,
    name:      (p.title || '').trim(),
    brand:     (p.brand || 'MY ARJA JEANS').trim(),
    price:     priceStr,
    salePrice: p.salePrice ?? null,
    listPrice: p.listPrice ?? null,
    stock:     p.quantity ?? 0,
    image:     img,
    localImage: null,
    isNew,
    createdAt: p.createDateTime ?? null,
  };
});

// Stable sort: in-stock first, then newer first, then by id (deterministic)
out.sort((a, b) =>
  (b.stock - a.stock) ||
  ((b.createdAt || 0) - (a.createdAt || 0)) ||
  a.id.localeCompare(b.id)
);

// === Change detection ===
const newIds       = [];
const priceChanges = [];
const imageChanges = [];
const removedIds   = [];

for (const oldId of Object.keys(previous)) {
  if (!out.find(p => p.id === oldId)) removedIds.push(oldId);
}

for (const p of out) {
  const prev = previous[p.id];
  if (!prev) {
    newIds.push(p.id);
    continue;
  }
  if ((prev.salePrice ?? null) !== (p.salePrice ?? null)) {
    priceChanges.push({ id: p.id, name: p.name.slice(0, 50), from: prev.salePrice, to: p.salePrice });
  }
  if ((prev.image || '') !== (p.image || '')) {
    imageChanges.push(p.id);
  }
}

console.log(`\n=== Changes ===`);
console.log(`  + Yeni:           ${newIds.length}`);
console.log(`  - Kaldırılan:     ${removedIds.length}`);
console.log(`  ₺ Fiyat değişen: ${priceChanges.length}`);
console.log(`  📷 Görsel değişen: ${imageChanges.length}`);
if (priceChanges.length) {
  console.log(`  Fiyat detayları (ilk 8):`);
  for (const c of priceChanges.slice(0, 8)) {
    console.log(`    ${c.id}  ${fmt(c.from)} → ${fmt(c.to)} TL  (${c.name})`);
  }
}

// Delete local image for products with changed image URL — they will be re-downloaded
for (const id of imageChanges) {
  for (const ext of ['jpg', 'jpeg', 'png', 'webp']) {
    const dest = path.join(IMG_DIR, `${id}.${ext}`);
    if (fs.existsSync(dest)) {
      fs.unlinkSync(dest);
      console.log(`  ↻ removed stale image ${id}.${ext} (URL changed)`);
    }
  }
}

// Download images: new ones + the ones we just deleted because of URL change
let dl = 0, cached = 0, failed = 0;
for (const p of out) {
  if (!p.image) continue;
  const m = p.image.match(/\.(jpe?g|png|webp)(?:\?|$)/i);
  const ext = (m ? m[1] : 'jpg').toLowerCase().replace('jpeg', 'jpg');
  const dest = path.join(IMG_DIR, `${p.id}.${ext}`);
  if (fs.existsSync(dest)) {
    p.localImage = `brand_assets/products/${path.basename(dest)}`;
    cached++;
    continue;
  }
  try {
    const bigUrl = p.image.replace(/\/mnresize\/\d+\/-?\/?\d*\//, '/mnresize/1200/-/');
    try { await downloadImage(bigUrl, dest); }
    catch { await downloadImage(p.image, dest); }
    p.localImage = `brand_assets/products/${path.basename(dest)}`;
    dl++;
  } catch (e) {
    failed++;
    console.warn(`  ! image fail ${p.id}: ${e.message}`);
  }
}
console.log(`\nImages: ${dl} new, ${cached} cached, ${failed} failed.`);

// Cleanup stale images for products that no longer exist
const validIds = new Set(out.map(p => p.id));
let removed = 0;
for (const f of fs.readdirSync(IMG_DIR)) {
  const m = f.match(/^([^.]+)\./);
  if (m && !validIds.has(m[1])) {
    fs.unlinkSync(path.join(IMG_DIR, f));
    removed++;
  }
}
if (removed) console.log(`Cleanup: removed ${removed} stale image(s).`);

// Write outputs
fs.writeFileSync(META_OUT, JSON.stringify(out, null, 2), 'utf8');
console.log(`✓ Wrote ${out.length} products to ${META_OUT}`);

const summary = {
  total:         out.length,
  newCount:      newIds.length,
  removedCount:  removedIds.length,
  priceChanges:  priceChanges.length,
  imageUpdates:  imageChanges.length,
  syncedAt:      new Date().toISOString(),
};
fs.writeFileSync(SUMMARY_OUT, JSON.stringify(summary, null, 2), 'utf8');
console.log(`✓ Wrote sync summary to ${SUMMARY_OUT}`);

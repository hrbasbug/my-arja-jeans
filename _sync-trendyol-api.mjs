/**
 * Trendyol Marketplace API → products.json + lokal görseller senkronizasyonu.
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

const IMG_DIR  = path.join(__dirname, 'brand_assets', 'products');
const META_OUT = path.join(__dirname, 'brand_assets', 'products.json');
if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true });

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

// Filter to only products that should be visible on the public site
const filtered = raw.filter(p => p.approved && !p.rejected && !p.blacklisted && p.onSale !== false);
console.log(`\nTotal raw: ${raw.length}, After approval/onSale filter: ${filtered.length}`);

// === DEDUPE ===
// Trendyol API returns one entry per color/size variant. Group them by productMainId
// (the parent product code) and keep ONE representative per group: highest-stock variant,
// breaking ties by lowest listPrice (cheapest "default" wins).
const byMain = new Map();
for (const p of filtered) {
  const key = p.productMainId || p.productCode || p.productContentId || p.id;
  const existing = byMain.get(key);
  if (!existing) { byMain.set(key, p); continue; }
  const a = p.quantity ?? 0, b = existing.quantity ?? 0;
  if (a > b) { byMain.set(key, p); continue; }
  if (a === b && (p.listPrice ?? Infinity) < (existing.listPrice ?? Infinity)) {
    byMain.set(key, p);
  }
}
const visible = Array.from(byMain.values());
console.log(`Deduped by productMainId: ${filtered.length} variants → ${visible.length} unique products`);

// Transform to existing products.json shape (compatible with _build-products.mjs)
const out = visible.map(p => {
  const img = (p.images && p.images[0] && p.images[0].url) || '';
  let priceStr = null;
  if (p.salePrice && p.listPrice && p.salePrice < p.listPrice) {
    priceStr = `Sepette${fmt(p.salePrice)} TL${fmt(p.listPrice)} TL`;
  } else if (p.salePrice) {
    priceStr = `${fmt(p.salePrice)} TL`;
  }
  // Trendyol API returns:
  //   id              -> internal hash (32-char hex, NOT for public URLs)
  //   productContentId -> public numeric ID used in trendyol.com URLs
  //   productUrl       -> full public URL (preferred)
  const publicId = p.productContentId || p.id;
  return {
    id:        String(publicId),
    href:      p.productUrl || `https://www.trendyol.com/-p-${publicId}`,
    name:      (p.title || '').trim(),
    brand:     (p.brand || 'MY ARJA JEANS').trim(),
    price:     priceStr,
    salePrice: p.salePrice ?? null,
    listPrice: p.listPrice ?? null,
    stock:     p.quantity ?? 0,
    image:     img,
    localImage: null,
  };
});

// Stable sort: in-stock first, then by id (stable across runs)
out.sort((a, b) => (b.stock - a.stock) || a.id.localeCompare(b.id));

// Download missing images (existing ones are kept — content-addressed by id)
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

// Remove stale local images for products that no longer exist
const validIds = new Set(out.map(p => p.id));
let removed = 0;
for (const f of fs.readdirSync(IMG_DIR)) {
  const m = f.match(/^(\d+)\./);
  if (m && !validIds.has(m[1])) {
    fs.unlinkSync(path.join(IMG_DIR, f));
    removed++;
  }
}
if (removed) console.log(`Cleanup: removed ${removed} stale image(s).`);

fs.writeFileSync(META_OUT, JSON.stringify(out, null, 2), 'utf8');
console.log(`✓ Wrote ${out.length} products to ${META_OUT}`);

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRODUCTS = JSON.parse(fs.readFileSync(path.join(__dirname, 'brand_assets', 'products.json'), 'utf8'));
const HTML_PATH = path.join(__dirname, 'index.html');

const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function cleanName(raw) {
  if (!raw) return '';
  let s = raw
    .replace(/^MY\s*ARJA\s*JEANS\s*/i, '')
    .replace(/^MY\s*ARJA\s*/i, '')
    .replace(/\[[^\]]*\]/g, '')          // strip [bracketed]
    .replace(/\([^)]*\)/g, '')           // strip (parens)
    .replace(/[​-‍﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Title-case "kadın" → "Kadın", normalise common all-caps phrases
  s = s.replace(/\bkadın\b/gi, 'Kadın');
  s = s.replace(/\bjean(s)?\b/gi, m => 'Jean' + (m.endsWith('s') ? 's' : ''));
  s = s.replace(/\bpantolon\b/gi, 'Pantolon');
  s = s.replace(/\betek\b/gi, 'Etek');
  return s;
}

function parsePrice(s) {
  if (!s) return { current: null, original: null };
  const m = s.match(/(\d{1,3}(?:\.\d{3})*(?:,\d{2})?)\s*TL/g) || [];
  return { current: m[0] || null, original: m[1] || null };
}

function categoryOf(name) {
  const n = name.toLowerCase();
  if (/\betek\b/.test(n)) return 'etek';
  if (/wide leg|palazzo|geniş paça|bol paça|baggy/.test(n)) return 'bol';
  if (/dar paça|skinny|dar kesim/.test(n)) return 'dar';
  if (/jean|kot/.test(n)) return 'jean';
  if (/pantolon|kumaş/.test(n)) return 'pantolon';
  return 'diger';
}

const CAT_LABELS = {
  hepsi: 'Tümü',
  jean: 'Jean',
  pantolon: 'Kumaş Pantolon',
  bol: 'Bol Paça',
  dar: 'Dar Paça',
  etek: 'Etek',
  diger: 'Diğer',
};

function arrowSvg(size = 14) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m13 5 7 7-7 7"/></svg>`;
}

function externalSvg(size = 14) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 5h5v5"/><path d="M19 5 9 15"/><path d="M19 14v5H5V5h5"/></svg>`;
}

const productCards = PRODUCTS.map((p, i) => {
  const name = cleanName(p.name);
  const { current, original } = parsePrice(p.price);
  const cat = categoryOf(name);
  const img = p.localImage || p.image || '';
  const newBadge = p.isNew
    ? `\n            <span class="absolute top-3 left-3 z-10 bg-gradient-to-br from-lilac to-rose text-ink text-[11px] uppercase tracking-[.18em] px-2.5 py-1 rounded-full font-medium shadow-card">Yeni</span>`
    : '';
  return `        <a href="${escapeHtml(p.href)}" target="_blank" rel="noopener noreferrer"
          class="product group block" data-cat="${cat}" data-reveal>
          <div class="img-treat rounded-2xl aspect-[4/5] bg-haze">
            <img class="pimg" loading="lazy" decoding="async" src="${escapeHtml(img)}" alt="${escapeHtml(name)}"/>
            <div class="tone"></div>${newBadge}
          </div>
          <div class="mt-3">
            <p class="text-[10px] uppercase tracking-[.22em] text-ash">My Arja</p>
            <h3 class="font-display text-[15px] leading-snug mt-1 product-name">${escapeHtml(name)}</h3>
            <div class="mt-2 flex items-baseline gap-2 flex-wrap">
              <span class="font-medium text-ink">${escapeHtml(current || '-')}</span>${original && original !== current ? `
              <span class="text-[12px] text-ash line-through">${escapeHtml(original)}</span>` : ''}
            </div>
            <p class="mt-1.5 inline-flex items-center gap-1 text-[11px] text-plum font-medium">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m20.59 13.41-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
              Avantajlı fiyat Trendyol'da
            </p>
            <span class="mt-2 inline-flex items-center gap-1.5 text-[12px] text-ink/70 font-medium link-u">
              Trendyol'da incele ${externalSvg(12)}
            </span>
          </div>
        </a>`;
}).join('\n');

// Build category counts
const catCounts = { hepsi: PRODUCTS.length };
for (const p of PRODUCTS) {
  const c = categoryOf(cleanName(p.name));
  catCounts[c] = (catCounts[c] || 0) + 1;
}
const catsOrder = ['hepsi', 'jean', 'pantolon', 'bol', 'dar', 'etek', 'diger'].filter(c => c === 'hepsi' || (catCounts[c] || 0) > 0);
const filterPills = catsOrder.map((c, i) => `        <button type="button" class="pill ${i === 0 ? 'pill-active' : ''}" data-filter="${c}">${CAT_LABELS[c]} <span class="pill-count">${catCounts[c] || 0}</span></button>`).join('\n');

const SECTION = `<!-- PRODUCTS_GRID_START -->
  <!-- ===== Tüm Ürünler (Trendyol mağazasından) ===== -->
  <section id="urunler" class="relative py-20 lg:py-28 bg-mist overflow-hidden">
    <div class="orb animate-float2" style="width:340px;height:340px;top:-100px;left:-100px;background:radial-gradient(circle, #B89FE8 0%, transparent 70%);"></div>
    <div class="orb animate-float3" style="width:280px;height:280px;bottom:10%;right:-80px;background:radial-gradient(circle, #E8B5C2 0%, transparent 70%);"></div>

    <div class="relative max-w-[1280px] mx-auto px-6">
      <div class="flex items-end justify-between flex-wrap gap-4 mb-10">
        <div>
          <p class="eyebrow mb-3" data-reveal><span class="dot"></span>Tüm Koleksiyon</p>
          <h2 class="h-display text-[40px] sm:text-[52px] lg:text-[64px]" data-reveal data-reveal-delay="1">${PRODUCTS.length} model, <span class="h-italic">tek koleksiyonda</span>.</h2>
        </div>
        <a href="https://www.trendyol.com/sr?mid=1199692&os=1" target="_blank" rel="noopener noreferrer" class="btn btn-aurora self-end" data-reveal data-reveal-delay="2" data-magnetic>
          Trendyol Mağazası ${externalSvg(14)}
        </a>
      </div>

      <!-- Filter pills -->
      <div class="flex flex-wrap gap-2 mb-10" id="productFilters" data-reveal data-reveal-delay="2">
${filterPills}
      </div>

      <!-- Product grid -->
      <div id="productsGrid" class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-5 lg:gap-7">
${productCards}
      </div>

      <p class="mt-8 text-center text-[13px] text-ash max-w-[680px] mx-auto leading-relaxed" data-reveal>
        Sitede gösterilen <strong class="text-ink font-medium">mağaza fiyatları</strong>dır.
        Trendyol'da <strong class="text-plum font-medium">sepet kampanyaları, Trendyol Plus indirimi ve "Avantajlı Ürün"</strong> rozetleriyle
        çoğu üründe daha düşük fiyatlar bulabilirsiniz. Bütün siparişler Trendyol üzerinden — güvenli ödeme &amp; hızlı teslimat.
      </p>
    </div>
  </section>
  <!-- PRODUCTS_GRID_END -->`;

// Inject between markers
let html = fs.readFileSync(HTML_PATH, 'utf8');
const startMarker = '<!-- PRODUCTS_GRID_START -->';
const endMarker = '<!-- PRODUCTS_GRID_END -->';
const startIdx = html.indexOf(startMarker);
const endIdx = html.indexOf(endMarker);

if (startIdx === -1 || endIdx === -1) {
  console.error('!!! Markers not found in index.html. Add them manually first:');
  console.error('   <!-- PRODUCTS_GRID_START -->\n   <!-- PRODUCTS_GRID_END -->');
  process.exit(1);
}

const before = html.slice(0, startIdx);
const after = html.slice(endIdx + endMarker.length);
html = before + SECTION + after;

// --- Static image slots (hero, story, categories) ---
// Replace src+alt of <img data-static="<slot>"> with a fresh, unique product from live data.
const usedSlotIds = new Set();
function pickUnique(cat, idx = 0) {
  const pool = PRODUCTS
    .filter(p => p.localImage && !usedSlotIds.has(p.id) && categoryOf(cleanName(p.name)) === cat);
  let chosen = pool[idx % Math.max(1, pool.length)];
  if (!chosen) {
    // fallback: any unused product with image
    chosen = PRODUCTS.find(p => p.localImage && !usedSlotIds.has(p.id));
  }
  if (chosen) usedSlotIds.add(chosen.id);
  return chosen;
}

const SLOTS = {
  'hero':    pickUnique('jean', 2),
  'story-1': pickUnique('bol', 1),
  'story-2': pickUnique('jean', 5),
  'cat-1':   pickUnique('pantolon', 0),  // Yüksek Bel
  'cat-2':   pickUnique('bol', 0),       // Bol Paça
  'cat-3':   pickUnique('jean', 0),      // Dar Kesim
};

let replacedSlots = 0;
for (const [slot, prod] of Object.entries(SLOTS)) {
  if (!prod || !prod.localImage) continue;
  const cleanedName = cleanName(prod.name).slice(0, 100);
  // Match the img tag carrying data-static="<slot>" and rewrite its src + alt
  const re = new RegExp(`(<img[^>]*?data-static="${slot}"[^>]*?\\s)src="[^"]*"([^>]*?\\salt=")[^"]*("[^>]*>)`, 'i');
  const before2 = html;
  html = html.replace(re, (_m, p1, p2, p3) => `${p1}src="${escapeHtml(prod.localImage)}"${p2}${escapeHtml(cleanedName)}${p3}`);
  if (html !== before2) replacedSlots++;
}

fs.writeFileSync(HTML_PATH, html, 'utf8');
console.log(`✓ Injected ${PRODUCTS.length} products into index.html`);
console.log(`  Categories:`, Object.fromEntries(catsOrder.map(c => [CAT_LABELS[c], catCounts[c]])));
console.log(`  Static image slots filled: ${replacedSlots}/${Object.keys(SLOTS).length}`);

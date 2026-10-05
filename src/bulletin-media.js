/**
 * Bulletin media pipeline:
 *  1. Cover images — resolved from the ORIGIN of the story (og:image on the
 *     publisher's article page), with a keyword image-search fallback
 *     (Wikimedia Commons) and AI relevance matching when several candidates
 *     are available. Results are cached on disk per bulletin.
 *  2. Full stories — the actual story behind the headline: the origin article
 *     is located and fetched, then expounded with AI + Google Search grounding
 *     into a fully-fledged legal news story. Cached on disk per bulletin.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cheerio = require('cheerio');

const DATA_DIR = path.join(__dirname, '..', 'data');
const IMAGE_CACHE_FILE = path.join(DATA_DIR, 'bulletin_images.json');
const STORY_CACHE_FILE = path.join(DATA_DIR, 'bulletin_stories.json');

const IMAGE_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
const STORY_CACHE_TTL = 3 * 24 * 60 * 60 * 1000; // 3 days

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─── Persistent disk caches ────────────────────────────────────────────────
let imageCache = null;
let storyCache = null;
let saveTimer = null;

function loadCaches() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (_) { }
  if (!imageCache) {
    try {
      imageCache = JSON.parse(fs.readFileSync(IMAGE_CACHE_FILE, 'utf8'));
    } catch (_) { imageCache = {}; }
  }
  if (!storyCache) {
    try {
      storyCache = JSON.parse(fs.readFileSync(STORY_CACHE_FILE, 'utf8'));
    } catch (_) { storyCache = {}; }
  }
}

function scheduleCacheSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      if (imageCache) fs.writeFileSync(IMAGE_CACHE_FILE, JSON.stringify(imageCache));
      if (storyCache) fs.writeFileSync(STORY_CACHE_FILE, JSON.stringify(storyCache));
    } catch (e) {
      console.warn('[bulletin-media] Cache save warning:', e.message);
    }
  }, 500);
}

// ─── Publisher → origin domain map (Google News strips the real link) ──────
const PUBLISHER_DOMAINS = {
  'daily nation': 'nation.africa',
  'nation': 'nation.africa',
  'nation.africa': 'nation.africa',
  'the east african': 'theeastafrican.co.ke',
  'standard media': 'standardmedia.co.ke',
  'the standard': 'standardmedia.co.ke',
  'standard': 'standardmedia.co.ke',
  'the star': 'the-star.co.ke',
  'star kenya': 'the-star.co.ke',
  'business daily': 'businessdailyafrica.com',
  'citizen': 'citizen.digital',
  'citizen digital': 'citizen.digital',
  'people daily': 'peopledaily.co.ke',
  'taifa leo': 'taifaleo.nation.africa',
  'kenya gazette': 'kenyalaw.org',
  'kenya law': 'kenyalaw.org',
  'judiciary': 'judiciary.go.ke',
  'judiciary of kenya': 'judiciary.go.ke',
  'parliament': 'parliament.go.ke',
  'national assembly': 'parliament.go.ke',
  'senate': 'parliament.go.ke',
  'law society of kenya': 'lsk.or.ke',
  'lsk': 'lsk.or.ke',
  'capital business': 'capitalfm.co.ke',
  'capital fm': 'capitalfm.co.ke',
  'kenya broadcasting corporation': 'kbc.co.ke',
  'kbc': 'kbc.co.ke',
  'ktn news': 'standardmedia.co.ke',
  'ntv kenya': 'ntvkenya.nation.africa'
};

function publisherDomain(sourceName = '') {
  const key = String(sourceName || '').toLowerCase().trim();
  if (PUBLISHER_DOMAINS[key]) return PUBLISHER_DOMAINS[key];
  for (const [name, domain] of Object.entries(PUBLISHER_DOMAINS)) {
    if (key.includes(name)) return domain;
  }
  return null;
}

function isNewsGoogleRedirect(url = '') {
  return String(url || '').includes('news.google.com');
}

// ─── Shared HTTP helpers ───────────────────────────────────────────────────
async function fetchWithTimeout(url, opts = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...opts,
      signal: controller.signal,
      redirect: 'follow',
      headers: Object.assign({
        'User-Agent': BROWSER_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      }, opts.headers || {})
    });
  } finally {
    clearTimeout(tid);
  }
}

function extractImageFromHtml(html = '', baseUrl = '') {
  if (!html) return null;
  try {
    const $ = cheerio.load(html);
    const candidates = [
      $('meta[property="og:image"]').attr('content'),
      $('meta[property="og:image:secure_url"]').attr('content'),
      $('meta[name="twitter:image"]').attr('content'),
      $('meta[name="twitter:image:src"]').attr('content'),
      $('link[rel="image_src"]').attr('href')
    ];
    for (const c of candidates) {
      if (c && /^https?:\/\//i.test(c.trim())) return c.trim();
    }
    // First sizeable content image inside the article body
    const img = $('article img[src], .post-content img[src], .entry-content img[src], main img[src], img[src]').first().attr('src');
    if (img && /^https?:\/\//i.test(img) && !/(logo|sprite|avatar|icon|banner|placeholder|default)/i.test(img)) {
      return img;
    }
  } catch (_) { }
  return null;
}

// ─── Origin article discovery (via DDG site-scoped search) ─────────────────
const originArticleCache = new Map();

async function findOriginArticleUrl(bulletin, timeoutMs = 7000) {
  const cacheKey = (bulletin.id || bulletin.title || '').toLowerCase();
  if (cacheKey && originArticleCache.has(cacheKey)) {
    return originArticleCache.get(cacheKey);
  }

  // Direct publisher links (non-Google-News) can be used as-is
  const directUrl = bulletin.sourceUrl || bulletin.url || '';
  if (directUrl && /^https?:\/\//i.test(directUrl) && !isNewsGoogleRedirect(directUrl)) {
    if (cacheKey) originArticleCache.set(cacheKey, directUrl);
    return directUrl;
  }

  const domain = publisherDomain(bulletin.source || bulletin.sourceName || '');
  const title = String(bulletin.title || '').replace(/[^\w\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
  const titleTokens = title.split(' ').slice(0, 10).join(' ');
  if (!domain || !titleTokens) return null;

  try {
    const q = `site:${domain} ${titleTokens}`;
    const res = await fetchWithTimeout(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, {}, timeoutMs);
    if (!res.ok) return null;
    const html = await res.text();
    const $ = cheerio.load(html);

    let found = null;
    $('.result .result__title a, a.result__a').each((_, el) => {
      if (found) return;
      let href = $(el).attr('href') || '';
      if (href.includes('uddg=')) {
        const m = href.match(/uddg=([^&]+)/);
        if (m) href = decodeURIComponent(m[1]);
      }
      if (/^https?:\/\//i.test(href) && href.includes(domain)) {
        found = href;
      }
    });

    if (found && cacheKey) originArticleCache.set(cacheKey, found);
    return found;
  } catch (e) {
    console.warn('[bulletin-media] Origin search note:', e.message);
    return null;
  }
}

async function fetchOriginImage(articleUrl, timeoutMs = 6000) {
  if (!articleUrl) return null;
  try {
    const res = await fetchWithTimeout(articleUrl, {
      headers: { 'Referer': new URL(articleUrl).origin + '/' }
    }, timeoutMs);
    if (!res.ok) return null;
    const html = await res.text();
    return extractImageFromHtml(html, articleUrl);
  } catch (_) {
    return null;
  }
}

// ─── Keyword image search fallback (Wikimedia Commons) ─────────────────────
async function searchCommonsImages(keywords = '', limit = 6, timeoutMs = 5000) {
  if (!keywords) return [];
  try {
    const clean = String(keywords).replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const apiUrl = 'https://commons.wikimedia.org/w/api.php?action=query&generator=search' +
      `&gsrsearch=${encodeURIComponent(clean)}&gsrnamespace=6&gsrlimit=${limit}` +
      '&prop=imageinfo&iiprop=url&iiurlwidth=1000&format=json&origin=*';
    const res = await fetchWithTimeout(apiUrl, {}, timeoutMs);
    if (!res.ok) return [];
    const data = await res.json();
    const pages = data.query ? Object.values(data.query.pages || {}) : [];
    const out = [];
    for (const p of pages) {
      const ii = p.imageinfo && p.imageinfo[0];
      const url = ii && (ii.thumburl || ii.url);
      if (url && /\.(jpe?g|png|webp)(\?|$)/i.test(url)) {
        out.push({ url, title: p.title || '', source: 'Wikimedia Commons', originUrl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(p.title || '')}` });
      }
    }
    return out;
  } catch (e) {
    console.warn('[bulletin-media] Commons search note:', e.message);
    return [];
  }
}

// ─── AI relevance matching ─────────────────────────────────────────────────
async function aiPickImage(bulletin, candidates = [], getAiClient) {
  if (!getAiClient || candidates.length < 2) return null;
  const ai = getAiClient();
  if (!ai) return null;

  const listing = candidates.map((c, i) => ({ index: i, title: (c.title || '').slice(0, 100), source: c.source || '' }));
  const prompt = `You are the photo editor of a Kenyan legal news publication.
News headline: "${String(bulletin.title || '').slice(0, 200)}"
Category: ${bulletin.categoryLabel || bulletin.category || 'legal news'}

Candidate images:
${JSON.stringify(listing, null, 1)}

Pick the index of the image MOST relevant to the headline (courts, judges, legal documents, government buildings, or the specific subject of the story). Avoid logos or unrelated subjects.
Respond with ONLY the index number (e.g. 2).`;

  for (const model of ['gemini-flash-latest', 'gemini-2.5-flash']) {
    try {
      const resp = await Promise.race([
        ai.models.generateContent({ model, contents: prompt, config: { temperature: 0 } }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('ai timeout')), 8000))
      ]);
      const text = String(resp && resp.text || '').trim();
      const idx = parseInt(text.replace(/[^0-9]/g, ''), 10);
      if (!isNaN(idx) && idx >= 0 && idx < candidates.length) return idx;
    } catch (_) { }
  }
  return null;
}

// ─── Public: resolve the cover image for one bulletin ──────────────────────
async function resolveBulletinImage(bulletin, { getAiClient = null, timeoutMs = 9000 } = {}) {
  loadCaches();
  const id = bulletin.id || crypto.createHash('md5').update(String(bulletin.title || '')).digest('hex').substring(0, 12);

  const cached = imageCache[id];
  if (cached && cached.imageUrl && (Date.now() - (cached.resolvedAt || 0)) < IMAGE_CACHE_TTL) {
    return cached;
  }

  const result = await Promise.race([
    (async () => {
      // Strategy 1: the actual image from the ORIGIN of the story
      const articleUrl = await findOriginArticleUrl(bulletin, Math.min(6000, timeoutMs));
      if (articleUrl) {
        const originImage = await fetchOriginImage(articleUrl, Math.min(6000, timeoutMs));
        if (originImage) {
          return { imageUrl: originImage, originUrl: articleUrl, strategy: 'origin', resolvedAt: Date.now() };
        }
      }

      // Strategy 2: keyword image search (Wikimedia Commons) + AI relevance match
      const keywords = `${bulletin.title || ''} ${Array.isArray(bulletin.tags) ? bulletin.tags.join(' ') : ''} Kenya law court`
        .replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 120);
      let candidates = await searchCommonsImages(keywords, 6, Math.min(5000, timeoutMs));

      // Strategy 3: the publisher-domain homepage masthead as a last resort is
      // useless — instead reuse the curated landmark set from the crawler.
      if (candidates.length === 0) return null;

      // Use AI to pick the image that best matches the specific story
      let picked = null;
      try {
        const idx = await aiPickImage(bulletin, candidates, getAiClient);
        picked = idx !== null ? candidates[idx] : null;
      } catch (_) { }
      if (!picked) picked = candidates[0];

      return { imageUrl: picked.url, originUrl: picked.originUrl || null, strategy: 'search', resolvedAt: Date.now() };
    })(),
    new Promise(resolve => setTimeout(() => resolve(null), timeoutMs))
  ]);

  if (result && result.imageUrl) {
    imageCache[id] = result;
    scheduleCacheSave();
    return result;
  }
  return null;
}

// ─── Full story generation ─────────────────────────────────────────────────
async function extractArticleText(articleUrl, timeoutMs = 7000) {
  if (!articleUrl) return null;
  try {
    const res = await fetchWithTimeout(articleUrl, {}, timeoutMs);
    if (!res.ok) return null;
    const html = await res.text();
    const $ = cheerio.load(html);
    $('script, style, noscript, nav, header, footer, aside, form, iframe, .ad, .advertisement, .related, .comments').remove();

    const container = $('article').first().length ? $('article').first()
      : ($('.post-content').first().length ? $('.post-content').first()
        : ($('.entry-content').first().length ? $('.entry-content').first() : $('body')));

    const paragraphs = [];
    container.find('p').each((_, el) => {
      const t = $(el).text().replace(/\s+/g, ' ').trim();
      if (t.length > 40) paragraphs.push(t);
      if (paragraphs.length >= 24) return false;
    });

    if (paragraphs.length === 0) {
      const bodyText = container.text().replace(/\s+/g, ' ').trim();
      if (bodyText.length > 300) return bodyText.substring(0, 6000);
      return null;
    }
    return paragraphs.join('\n\n').substring(0, 7000);
  } catch (_) {
    return null;
  }
}

function fallbackStoryHtml(bulletin, originText, articleUrl) {
  const paragraphs = (originText || bulletin.content || bulletin.summary || '')
    .split(/\n\s*\n|\.\s+(?=[A-Z])/)
    .map(p => p.trim())
    .filter(p => p.length > 30)
    .slice(0, 14);

  const body = paragraphs.length > 0
    ? paragraphs.map(p => `<p>${p.replace(/</g, '&lt;')}</p>`).join('\n')
    : `<p>${String(bulletin.summary || bulletin.content || 'Full details of this development are available at the original source.').replace(/</g, '&lt;')}</p>`;

  const notice = originText
    ? `<p class="story-attribution"><em>Story excerpts republished from the original report by ${escapeHtmlText(bulletin.source || 'the publisher')}.</em></p>`
    : `<p class="story-attribution"><em>This summary is based on the bulletin record. Read the full report at the original source.</em></p>`;

  return `
    <div class="story-section">
      <h2>Overview</h2>
      <p>${escapeHtmlText(bulletin.summary || '')}</p>
    </div>
    <div class="story-section">
      <h2>The Story</h2>
      ${body}
    </div>
    ${notice}
    ${articleUrl ? `<p><a href="${escapeHtmlText(articleUrl)}" target="_blank" rel="noopener noreferrer">Read the original report on ${escapeHtmlText(bulletin.source || 'the publisher\u2019s website')} \u2197</a></p>` : ''}`;
}

function escapeHtmlText(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function generateAiStory(bulletin, originText, originUrl, getAiClient) {
  if (!getAiClient) return null;
  const ai = getAiClient();
  if (!ai) return null;

  const prompt = `You are the chief legal affairs editor of the eLegal Bulletin, a Kenyan legal news publication (in the style of Nation Africa / The Standard law & courts pages).

Write the FULL news story behind this legal bulletin headline.

HEADLINE: ${bulletin.title}
PUBLISHER OF ORIGINAL REPORT: ${bulletin.source || 'Kenyan media'}
CATEGORY: ${bulletin.categoryLabel || bulletin.category || 'Legal news'}
BULLETIN SUMMARY: ${String(bulletin.summary || '').slice(0, 400)}
ORIGINAL REPORT EXCERPT (use as the factual base; do not contradict it):
"""
${(originText || bulletin.content || bulletin.summary || '').slice(0, 6000)}
"""

RULES:
1. FAITHFUL REPORTING: expand ONLY with facts you can ground via Google Search (court names, parties, statutes, prior rulings, official reactions). NEVER invent quotes, case names, numbers, or outcomes.
2. Structure as rich HTML article body (no <html>/<body>/markdown): use <h2> section headings and <p> paragraphs, 600-1000 words total. Sections like: the lede (what happened), Background, The ruling / development, Legal significance, What happens next.
3. Formal news register, Kenyan legal context, precise statutory references where grounded.
4. End with a short editor's note paragraph crediting the original report by ${escapeHtmlText(bulletin.source || 'Kenyan media')}.
5. Respond with ONLY the HTML article body.`;

  for (const model of ['gemini-flash-latest', 'gemini-2.5-flash']) {
    try {
      const resp = await Promise.race([
        ai.models.generateContent({
          model,
          contents: prompt,
          config: { tools: [{ googleSearch: {} }], temperature: 0.35 }
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('ai timeout')), 30000))
      ]);
      let html = String(resp && resp.text || '')
        .replace(/```html/gi, '')
        .replace(/```/g, '')
        .trim();
      if (/<(h2|p)[\s>]/i.test(html) && html.length > 400) {
        return html;
      }
    } catch (e) {
      console.warn(`[bulletin-media] Story generation note (${model}):`, e.message);
    }
  }
  return null;
}

// ─── Public: get (and lazily generate) the full story for one bulletin ─────
async function getBulletinStory(bulletin, { getAiClient = null, timeoutMs = 40000 } = {}) {
  loadCaches();
  const id = bulletin.id || crypto.createHash('md5').update(String(bulletin.title || '')).digest('hex').substring(0, 12);

  const cached = storyCache[id];
  if (cached && cached.storyHtml && (Date.now() - (cached.generatedAt || 0)) < STORY_CACHE_TTL) {
    return cached;
  }

  const result = await Promise.race([
    (async () => {
      // 1. Locate + fetch the actual origin article
      const originUrl = await findOriginArticleUrl(bulletin, 7000);
      const originText = await extractArticleText(originUrl, 7000);

      // 2. AI-expound the full story with Google Search grounding
      const aiHtml = await generateAiStory(bulletin, originText, originUrl, getAiClient);
      if (aiHtml) {
        return {
          storyHtml: aiHtml,
          method: 'ai_grounded',
          sourceName: bulletin.source || 'Kenyan media',
          sourceUrl: originUrl || isNewsGoogleRedirect(bulletin.url || '') ? (originUrl || bulletin.url || '') : (bulletin.url || ''),
          generatedAt: Date.now()
        };
      }

      // 3. Fallback: republish the origin article text (or bulletin content)
      return {
        storyHtml: fallbackStoryHtml(bulletin, originText, originUrl),
        method: originText ? 'origin_article' : 'bulletin_record',
        sourceName: bulletin.source || 'Kenyan media',
        sourceUrl: originUrl || bulletin.url || '',
        generatedAt: Date.now()
      };
    })(),
    new Promise(resolve => setTimeout(() => resolve(null), timeoutMs))
  ]);

  if (result && result.storyHtml) {
    storyCache[id] = result;
    scheduleCacheSave();
    return result;
  }

  // Absolute fallback so the page always has something to render
  if (cached && cached.storyHtml) return cached;
  return {
    storyHtml: fallbackStoryHtml(bulletin, null, bulletin.url || ''),
    method: 'bulletin_record',
    sourceName: bulletin.source || 'Kenyan media',
    sourceUrl: bulletin.url || '',
    generatedAt: Date.now()
  };
}

module.exports = {
  resolveBulletinImage,
  getBulletinStory,
  findOriginArticleUrl,
  publisherDomain,
  loadCaches
};

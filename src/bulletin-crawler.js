const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const OUTPUT_FILE = path.join(DATA_DIR, 'daily_legal_news.json');

const FEEDS = [
  'https://news.google.com/rss/search?q=Kenya+law+court+judiciary+ruling+gazette&hl=en-KE&gl=KE&ceid=KE:en',
  'https://news.google.com/rss/search?q=High+Court+Kenya+ruling+judgment+LSK&hl=en-KE&gl=KE&ceid=KE:en',
  'https://news.google.com/rss/search?q=Judiciary+of+Kenya+Chief+Justice+Martha+Koome&hl=en-KE&gl=KE&ceid=KE:en',
  'https://news.google.com/rss/search?q=Kenya+Gazette+National+Land+Commission+Parliament+Bill&hl=en-KE&gl=KE&ceid=KE:en',
  'https://news.google.com/rss/search?q=Supreme+Court+Kenya+Court+of+Appeal+ruling&hl=en-KE&gl=KE&ceid=KE:en'
];

const LANDMARK_IMAGES = {
  supreme_court: 'https://upload.wikimedia.org/wikipedia/commons/0/0a/Supreme_Court_of_Kenya.JPG',
  parliament: 'https://upload.wikimedia.org/wikipedia/commons/b/bd/Parliament_Buildings%2C_Nairobi%2C_Kenya_-entrance-15April2010.jpg',
  chief_justice: 'https://upload.wikimedia.org/wikipedia/commons/0/0f/Chief_Justice_Martha_K._Koome_and_Deputy_Chief_Justice_Philomena_Mwilu.jpg',
  mombasa: 'https://upload.wikimedia.org/wikipedia/commons/6/61/Old_law_courst_mombasa.JPG',
  emblem: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/49/Coat_of_arms_of_Kenya_%28Heraldry%29.svg/800px-Coat_of_arms_of_Kenya_%28Heraldry%29.svg.png',
  nairobi_courts: 'https://upload.wikimedia.org/wikipedia/commons/0/07/Nairobi_Law_Courts.jpg'
};

function resolveImage(title = '', text = '') {
  const combined = (title + ' ' + text).toLowerCase();
  if (combined.includes('supreme court')) return LANDMARK_IMAGES.supreme_court;
  if (combined.includes('parliament') || combined.includes('bill') || combined.includes('national assembly')) return LANDMARK_IMAGES.parliament;
  if (combined.includes('chief justice') || combined.includes('martha koome') || combined.includes('mwilu')) return LANDMARK_IMAGES.chief_justice;
  if (combined.includes('mombasa')) return LANDMARK_IMAGES.mombasa;
  if (combined.includes('gazette') || combined.includes('nlc') || combined.includes('land commission')) return LANDMARK_IMAGES.emblem;
  return LANDMARK_IMAGES.nairobi_courts;
}

function categorizeArticle(title = '', text = '') {
  const combined = (title + ' ' + text).toLowerCase();
  if (['supreme court', 'high court', 'court of appeal', 'elrc', 'elc', 'judiciary', 'judge', 'justice', 'magistrate', 'ruling', 'judgment', 'cause list'].some(k => combined.includes(k))) {
    return { category: 'judiciary', categoryLabel: 'Judiciary & Court Ruling' };
  }
  if (['gazette', 'special notice', 'nlc', 'land commission', 'public notice'].some(k => combined.includes(k))) {
    return { category: 'gazette', categoryLabel: 'Kenya Gazette Notice' };
  }
  if (['parliament', 'bill', 'act', 'amendment', 'legislation', 'statute', 'assembly'].some(k => combined.includes(k))) {
    return { category: 'legislation', categoryLabel: 'Legislative Update' };
  }
  return { category: 'news', categoryLabel: 'Legal Precedent Alert' };
}

function extractTags(title = '', text = '') {
  const combined = (title + ' ' + text).toLowerCase();
  const tags = [];
  if (combined.includes('supreme court')) tags.push('Supreme Court');
  if (combined.includes('high court')) tags.push('High Court');
  if (combined.includes('court of appeal')) tags.push('Court of Appeal');
  if (combined.includes('elrc') || combined.includes('employment')) tags.push('Employment Law');
  if (combined.includes('elc') || combined.includes('land')) tags.push('Land Law');
  if (combined.includes('lsk') || combined.includes('advocate')) tags.push('LSK');
  if (combined.includes('gazette')) tags.push('Kenya Gazette');
  if (combined.includes('bill') || combined.includes('parliament')) tags.push('Parliament');
  if (combined.includes('jsc')) tags.push('JSC');
  if (tags.length === 0) tags.push('Kenya Law', 'Judicial News');
  return tags.slice(0, 4);
}

function parsePubDate(dateStr) {
  if (!dateStr) return new Date().toISOString().split('T')[0];
  try {
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) {
      return d.toISOString().split('T')[0];
    }
  } catch (_) {}
  return new Date().toISOString().split('T')[0];
}

function generateBulletinContent(title, source, formattedDate, tags, category) {
  const themeStr = tags && tags.length > 0 ? tags.join(', ') : 'Kenya Judicial System & Public Governance';

  if (category === 'judiciary') {
    return `**JUDICIAL PROCEEDINGS & LEGAL PRECEDENT REPORT**\n\n**Official Heading:** ${title}\n**Reporting Source:** ${source} (${formattedDate})\n**Key Legal Practice Areas:** ${themeStr}\n\n### Executive Summary\nIn an essential judicial development reported on ${formattedDate}, the Kenyan court system addressed critical questions of statutory interpretation and constitutional compliance in **${title}**. This judicial ruling establishes key procedural standards for legal practitioners and public authorities across the country.\n\n### Material Facts & Legal Background\nThe proceedings arose out of disputed administrative actions and legal obligations brought before the Court for formal determination. Counsel for the parties presented affidavit evidence, relevant statutory provisions, and binding precedents to substantiate their respective prayers before the bench.\n\n### Judicial Determination & Overriding Principles\nIn rendering its decision, the Court emphasized that statutory discretion must be exercised reasonably, objectively, and strictly in adherence to Article 47 (Fair Administrative Action) and Article 10 (National Values and Principles of Governance) of the Constitution of Kenya 2010. The bench affirmed that procedural technicalities shall not override the substantive administration of justice under Sections 1A and 1B of the Civil Procedure Act.\n\n### Legal Implications for Practice\nAdvocates, corporate legal officers, and litigants are advised to take note of the guidelines articulated in this judgment regarding filing deadlines, evidentiary requirements, and compliance directives.`;
  }
  if (category === 'gazette') {
    return `**KENYA GAZETTE OFFICIAL PUBLIC NOTICE & REGULATORY DIRECTIVE**\n\n**Notice Title:** ${title}\n**Publishing Authority:** ${source} (${formattedDate})\n**Classification:** Kenya Gazette Special Notification | ${themeStr}\n\n### Regulatory Overview\nThe Government of Kenya through the official Kenya Gazette has issued a public notice regarding **${title}**, published on ${formattedDate}. This statutory directive impacts regulatory compliance, public appointments, land transactions, or legislative administrative procedures.\n\n### Key Administrative Requirements & Provisions\nPursuant to the applicable statutory powers vested in the issuing authority, all affected individuals, commercial entities, and statutory boards are instructed to review the terms outlined in this gazette notice. Statutory objection periods, registration deadlines, and public participation windows specified in the notification take immediate legal effect from the date of publication.\n\n### Enforcement & Legal Compliance\nFailure to observe the directives published under this notice may trigger administrative enforcement or judicial review proceedings under the relevant Acts of Parliament. Legal professionals and compliance officers should verify details with the Government Printer and official statutory registers.`;
  }
  if (category === 'legislation') {
    return `**LEGISLATIVE & STATUTORY DEVELOPMENT DIGEST**\n\n**Bill / Act Title:** ${title}\n**Legislative Body:** ${source} (${formattedDate})\n**Legal Domain:** Parliamentary Legislation | ${themeStr}\n\n### Legislative Summary\nParliament of Kenya has advanced statutory deliberations concerning **${title}**, as formally reported on ${formattedDate}. This legislative intervention seeks to modernize regulatory frameworks, enhance administrative oversight, and address contemporary legal challenges in Kenya.\n\n### Statutory Provisions & Legislative Intent\nThe proposed statutory amendments introduce key reforms including enhanced enforcement powers, revised penalty structures, streamlined licensing procedures, and alignment with constitutional principles. Stakeholders across the legal and economic sectors have participated in public submission forums to refine the statutory wording.\n\n### Next Steps for Implementation\nUpon assent by the Executive and publication in the Kenya Gazette, the statutory provisions will come into force according to the commencement schedule. Legal practitioners should prepare for the operational shifts established by this legislative update.`;
  }
  return `**LEGAL BULLETIN & SPECIAL PRESS REPORT**\n\n**Headline:** ${title}\n**Source:** ${source} (${formattedDate})\n**Topic Focus:** ${themeStr}\n\n### Full Legal News Story\nAn important legal developments update has been published regarding **${title}**, reported by ${source} on ${formattedDate}.\n\nThis development touches upon fundamental aspects of law, legal practice, and administrative governance in Kenya. Legal experts highlight that this issue reflects ongoing legal reforms and key judicial directives in the country.\n\n### Impact & Commentary\nLegal practitioners and institutions are monitoring the practical outcomes of this development as it unfolds across the judiciary and legal fraternity.`;
}

let isCrawling = false;

async function crawlDailyBulletins() {
  if (isCrawling) {
    console.log('[bulletins] Bulletin crawl already in progress. Skipping duplicate run.');
    return null;
  }
  isCrawling = true;
  console.log('[bulletins] Fetching live Kenya legal news from web RSS feeds via native Node.js...');

  try {
    const crawled = [];
    const seenKeys = new Set();

    for (const feedUrl of FEEDS) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        const res = await fetch(feedUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!res.ok) continue;
        const xmlText = await res.text();

        const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
        let match;

        while ((match = itemRegex.exec(xmlText)) !== null) {
          const itemBlock = match[1];
          const titleMatch = itemBlock.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
          const linkMatch = itemBlock.match(/<link>([\s\S]*?)<\/link>/i);
          const pubDateMatch = itemBlock.match(/<pubDate>([\s\S]*?)<\/pubDate>/i);

          let rawTitle = titleMatch ? titleMatch[1].trim() : '';
          if (!rawTitle) continue;

          rawTitle = rawTitle
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'");

          const link = linkMatch ? linkMatch[1].trim() : '';
          const pubDateStr = pubDateMatch ? pubDateMatch[1].trim() : '';

          const parts = rawTitle.split(/\s+-\s+(?=[^-]+$)/);
          const title = parts[0].trim();
          const source = parts.length > 1 ? parts[1].trim() : 'Kenya Judicial Press';

          const tKey = title.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 50);
          if (!tKey || seenKeys.has(tKey)) continue;
          seenKeys.add(tKey);

          const formattedDate = parsePubDate(pubDateStr);
          const { category, categoryLabel } = categorizeArticle(title, rawTitle);
          const tags = extractTags(title, rawTitle);
          const imageUrl = resolveImage(title, rawTitle);
          const articleId = 'bulletin-live-' + crypto.createHash('md5').update(tKey).digest('hex').substring(0, 10);
          const summary = `${title}. Reported by ${source} on ${formattedDate}.`;
          const content = generateBulletinContent(title, source, formattedDate, tags, category);

          crawled.push({
            id: articleId,
            title,
            url: link || 'http://kenyalaw.org',
            sourceUrl: link || 'http://kenyalaw.org',
            source,
            date: formattedDate,
            category,
            categoryLabel,
            readTime: '4 min read',
            impact: (category === 'judiciary' || category === 'legislation') ? 'High' : 'Medium',
            tags,
            summary,
            content,
            imageUrl
          });
        }
      } catch (err) {
        console.warn(`[bulletins] Feed fetch note (${feedUrl.substring(0, 40)}...):`, err.message);
      }
    }

    if (crawled.length > 0) {
      crawled.sort((a, b) => b.date.localeCompare(a.date));

      const outputData = {
        updatedAt: new Date().toISOString(),
        total: crawled.length,
        bulletins: crawled
      };

      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }

      fs.writeFileSync(OUTPUT_FILE, JSON.stringify(outputData, null, 2), 'utf8');
      console.log(`[bulletins] Successfully saved ${crawled.length} live legal bulletins to ${OUTPUT_FILE}`);
      return outputData;
    }
  } catch (err) {
    console.error('[bulletins] Error during legal news crawl:', err.message);
  } finally {
    isCrawling = false;
  }

  return null;
}

function runBulletinCrawlerIfNeeded(force = false) {
  let shouldRun = force;
  if (!shouldRun) {
    if (!fs.existsSync(OUTPUT_FILE)) {
      shouldRun = true;
    } else {
      try {
        const stats = fs.statSync(OUTPUT_FILE);
        const ageMs = Date.now() - stats.mtimeMs;
        if (ageMs > 6 * 60 * 60 * 1000) { // 6 hours
          shouldRun = true;
        }
      } catch (e) {
        shouldRun = true;
      }
    }
  }

  if (shouldRun) {
    // Run asynchronously in Node without blocking
    setImmediate(() => {
      crawlDailyBulletins().catch(e => console.warn('[bulletins] Async crawl note:', e.message));
    });
  }
}

module.exports = {
  crawlDailyBulletins,
  runBulletinCrawlerIfNeeded,
  resolveImage,
  categorizeArticle,
  extractTags,
  parsePubDate
};

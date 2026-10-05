const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cheerio = require('cheerio');

const DATA_DIR = path.join(__dirname, '..', 'data');
const OUTPUT_FILE = path.join(DATA_DIR, 'daily_legal_news.json');

// Diverse, high-weight legal bulletin RSS channels covering all specialized courts, tribunals, and regulatory bodies
const FEEDS = [
  // 1. Apex & Appellate Judiciary
  { name: 'Supreme Court & Court of Appeal', url: 'https://news.google.com/rss/search?q=%22Supreme+Court+of+Kenya%22+OR+%22Court+of+Appeal+of+Kenya%22+OR+%22Court+of+Appeal%22+Kenya+ruling&hl=en-KE&gl=KE&ceid=KE:en' },
  // 2. High Court Jurisprudence & Judicial Review
  { name: 'High Court & Constitutional Law', url: 'https://news.google.com/rss/search?q=%22High+Court%22+Kenya+ruling+OR+judgment+OR+%22Article+47%22+OR+Milimani&hl=en-KE&gl=KE&ceid=KE:en' },
  // 3. Environment & Land Court (ELC)
  { name: 'Environment & Land Court (ELC)', url: 'https://news.google.com/rss/search?q=%22Environment+and+Land+Court%22+Kenya+OR+%22ELC%22+Kenya+land+title+ruling&hl=en-KE&gl=KE&ceid=KE:en' },
  // 4. Employment & Labour Relations Court (ELRC)
  { name: 'Employment & Labour Court (ELRC)', url: 'https://news.google.com/rss/search?q=%22Employment+and+Labour+Relations+Court%22+OR+%22ELRC%22+Kenya+ruling+OR+termination&hl=en-KE&gl=KE&ceid=KE:en' },
  // 5. Commercial, Corporate & Financial Law (Business Daily Africa)
  { name: 'Business Daily (Commercial & Tax)', url: 'https://news.google.com/rss/search?q=site:businessdailyafrica.com+court+OR+ruling+OR+law+OR+tribunal+OR+KRA&hl=en-KE&gl=KE&ceid=KE:en' },
  // 6. Tax Appeals Tribunal & Revenue Law
  { name: 'Tax Appeals Tribunal & KRA Legal', url: 'https://news.google.com/rss/search?q=%22Tax+Appeals+Tribunal%22+Kenya+OR+KRA+court+ruling+appeal&hl=en-KE&gl=KE&ceid=KE:en' },
  // 7. Kenya Gazette, Public Notices & Regulatory Decrees
  { name: 'Kenya Gazette & Executive Notices', url: 'https://news.google.com/rss/search?q=%22Kenya+Gazette%22+notice+OR+proclamation+OR+appointment+OR+revocation&hl=en-KE&gl=KE&ceid=KE:en' },
  // 8. Parliament of Kenya (Bills, Acts & Statutory Amendments)
  { name: 'Parliament (National Assembly & Senate)', url: 'https://news.google.com/rss/search?q=Kenya+Parliament+OR+%22National+Assembly%22+OR+Senate+Bill+OR+Act+legislation&hl=en-KE&gl=KE&ceid=KE:en' },
  // 9. Legal Profession, LSK & Judicial Service Commission
  { name: 'Law Society of Kenya & JSC', url: 'https://news.google.com/rss/search?q=%22Law+Society+of+Kenya%22+OR+LSK+OR+%22Judicial+Service+Commission%22+Kenya&hl=en-KE&gl=KE&ceid=KE:en' },
  // 10. Data Protection, Privacy & TechLaw
  { name: 'Data Protection & TechLaw (ODPC)', url: 'https://news.google.com/rss/search?q=%22Data+Protection%22+Kenya+OR+ODPC+penalty+OR+court+OR+ruling&hl=en-KE&gl=KE&ceid=KE:en' },
  // 11. Mainstream Legal Reporting (Nation Africa)
  { name: 'Nation Africa (Courts & Legal Affairs)', url: 'https://news.google.com/rss/search?q=site:nation.africa+court+OR+ruling+OR+judgment+OR+judiciary&hl=en-KE&gl=KE&ceid=KE:en' },
  // 12. Mainstream Judicial Press (Standard Media)
  { name: 'Standard Media (Courts & Precedents)', url: 'https://news.google.com/rss/search?q=site:standardmedia.co.ke+court+OR+ruling+OR+judgment+OR+judiciary&hl=en-KE&gl=KE&ceid=KE:en' },
  // 13. Judicial Integrity & Bench Updates (The Star Legal)
  { name: 'The Star Kenya (Courts & Judiciary)', url: 'https://news.google.com/rss/search?q=site:the-star.co.ke+judiciary+OR+court+OR+ruling+OR+%22high+court%22&hl=en-KE&gl=KE&ceid=KE:en' },
  // 14. East African Court of Justice & Regional Courts
  { name: 'East African Court of Justice (EACJ)', url: 'https://news.google.com/rss/search?q=%22East+African+Court+of+Justice%22+OR+EACJ+ruling+OR+judgment+Kenya&hl=en-KE&gl=KE&ceid=KE:en' },
  // 15. Anti-Corruption Court & Asset Recovery (EACC / ODPP)
  { name: 'Anti-Corruption & Asset Recovery', url: 'https://news.google.com/rss/search?q=%22Anti-Corruption+Court%22+Kenya+OR+EACC+forfeiture+OR+%22asset+recovery%22&hl=en-KE&gl=KE&ceid=KE:en' }
];

const LANDMARK_IMAGES = {
  supreme_court: 'https://upload.wikimedia.org/wikipedia/commons/0/0a/Supreme_Court_of_Kenya.JPG',
  parliament: 'https://upload.wikimedia.org/wikipedia/commons/b/bd/Parliament_Buildings%2C_Nairobi%2C_Kenya_-entrance-15April2010.jpg',
  chief_justice: 'https://upload.wikimedia.org/wikipedia/commons/0/0f/Chief_Justice_Martha_K._Koome_and_Deputy_Chief_Justice_Philomena_Mwilu.jpg',
  mombasa: 'https://upload.wikimedia.org/wikipedia/commons/6/61/Old_law_courst_mombasa.JPG',
  emblem: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/49/Coat_of_arms_of_Kenya_%28Heraldry%29.svg/800px-Coat_of_arms_of_Kenya_%28Heraldry%29.svg.png',
  nairobi_courts: 'https://upload.wikimedia.org/wikipedia/commons/0/07/Nairobi_Law_Courts.jpg',
  commercial: 'https://upload.wikimedia.org/wikipedia/commons/e/e0/Central_Bank_of_Kenya_building.jpg',
  regional: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2f/Flag_of_the_East_African_Community.svg/800px-Flag_of_the_East_African_Community.svg.png'
};

function resolveImage(title = '', text = '') {
  const combined = (title + ' ' + text).toLowerCase();
  if (combined.includes('supreme court')) return LANDMARK_IMAGES.supreme_court;
  if (combined.includes('parliament') || combined.includes('bill') || combined.includes('national assembly') || combined.includes('senate')) return LANDMARK_IMAGES.parliament;
  if (combined.includes('chief justice') || combined.includes('martha koome') || combined.includes('mwilu')) return LANDMARK_IMAGES.chief_justice;
  if (combined.includes('mombasa')) return LANDMARK_IMAGES.mombasa;
  if (combined.includes('commercial') || combined.includes('tax') || combined.includes('bank') || combined.includes('kra') || combined.includes('tribunal')) return LANDMARK_IMAGES.commercial;
  if (combined.includes('eacj') || combined.includes('east african')) return LANDMARK_IMAGES.regional;
  if (combined.includes('gazette') || combined.includes('nlc') || combined.includes('land commission')) return LANDMARK_IMAGES.emblem;
  return LANDMARK_IMAGES.nairobi_courts;
}

function categorizeArticle(title = '', text = '') {
  const combined = (title + ' ' + text).toLowerCase();
  if (['tax appeals tribunal', 'tax', 'kra', 'revenue', 'banking', 'bank', 'borrower', 'insolvency', 'bankruptcy', 'debt', 'commercial court', 'merger', 'competition authority', 'business daily', 'corporate', 'shares'].some(k => combined.includes(k))) {
    return { category: 'commercial', categoryLabel: 'Commercial, Tax & Banking' };
  }
  if (['elrc', 'employment and labour', 'labour court', 'unlawful termination', 'dismissal', 'salary', 'union', 'elc', 'environment and land', 'land court', 'title deed', 'adverse possession', 'land commission', 'nlc'].some(k => combined.includes(k))) {
    return { category: 'land_labour', categoryLabel: 'Land, Property & Labour (ELC/ELRC)' };
  }
  if (['data protection', 'odpc', 'privacy', 'cyber', 'techlaw', 'digital', 'lsk', 'law society of kenya', 'advocate', 'disciplinary', 'jsc', 'judicial service commission', 'eacc', 'anti-corruption', 'asset recovery'].some(k => combined.includes(k))) {
    return { category: 'governance', categoryLabel: 'Bar, TechLaw & Anti-Corruption' };
  }
  if (['gazette', 'special notice', 'proclamation', 'legal notice', 'public notice', 'appointment', 'revocation'].some(k => combined.includes(k))) {
    return { category: 'gazette', categoryLabel: 'Kenya Gazette Notice' };
  }
  if (['parliament', 'bill', 'act', 'amendment', 'legislation', 'statute', 'assembly', 'senate', 'national assembly'].some(k => combined.includes(k))) {
    return { category: 'legislation', categoryLabel: 'Legislative & Statutory Update' };
  }
  if (['supreme court', 'high court', 'court of appeal', 'judiciary', 'judge', 'justice', 'magistrate', 'ruling', 'judgment', 'cause list', 'eacj', 'east african court'].some(k => combined.includes(k))) {
    return { category: 'judiciary', categoryLabel: 'Judiciary & Court Ruling' };
  }
  return { category: 'news', categoryLabel: 'Legal Precedent Alert' };
}

function extractTags(title = '', text = '') {
  const combined = (title + ' ' + text).toLowerCase();
  const tags = [];
  if (combined.includes('supreme court')) tags.push('Supreme Court');
  if (combined.includes('court of appeal')) tags.push('Court of Appeal');
  if (combined.includes('high court')) tags.push('High Court');
  if (combined.includes('elc') || combined.includes('land court') || combined.includes('adverse possession')) tags.push('Land Law (ELC)');
  if (combined.includes('elrc') || combined.includes('employment') || combined.includes('labour')) tags.push('Labour Law (ELRC)');
  if (combined.includes('tax appeals') || combined.includes('kra') || combined.includes('tax')) tags.push('Tax Law');
  if (combined.includes('commercial') || combined.includes('banking') || combined.includes('debt') || combined.includes('insolvency')) tags.push('Commercial Law');
  if (combined.includes('data protection') || combined.includes('odpc') || combined.includes('privacy')) tags.push('Data Protection');
  if (combined.includes('lsk') || combined.includes('advocate')) tags.push('LSK');
  if (combined.includes('gazette')) tags.push('Kenya Gazette');
  if (combined.includes('bill') || combined.includes('parliament') || combined.includes('senate')) tags.push('Parliament');
  if (combined.includes('eacc') || combined.includes('corruption') || combined.includes('asset recovery')) tags.push('Asset Recovery');
  if (combined.includes('eacj') || combined.includes('east african')) tags.push('EACJ');
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

  if (category === 'commercial') {
    return `**COMMERCIAL, TAX & FINANCIAL LAW INTELLIGENCE REPORT**\n\n**Proceeding Title:** ${title}\n**Source Authority:** ${source} (${formattedDate})\n**Practice Focus:** Commercial Litigation, Banking & Revenue Law | ${themeStr}\n\n### Executive Summary\nA significant corporate and commercial jurisprudence milestone was reported on ${formattedDate} concerning **${title}**. This determination clarifies statutory duties and contractual boundaries for commercial lenders, corporate fiduciaries, and revenue authorities operating in Kenya.\n\n### Material Issues & Legal Analysis\nThe dispute centered upon statutory compliance, tax liability assessment, or contractual enforceability. The presiding tribunal or bench assessed the relevant provisions of the Tax Procedures Act, Companies Act 2015, or Banking Act alongside commercial law precedents.\n\n### Corporate & Advisory Implications\nCorporate legal counsel, financial advisors, and compliance heads must take note of the rulings directives regarding audit deadlines, contractual dispute arbitration clauses, and securities enforcement.`;
  }
  if (category === 'land_labour') {
    return `**LAND, PROPERTY & LABOUR RELATIONS JUDICIAL BULLETIN**\n\n**Case / Dispute Title:** ${title}\n**Forum / Source:** ${source} (${formattedDate})\n**Specialized Jurisdiction:** Environment & Land Court (ELC) / Employment & Labour Relations Court (ELRC) | ${themeStr}\n\n### Case Background & Ratio Decidendi\nIn a crucial ruling on ${formattedDate}, the Court delivered judicial directions on **${title}**. The judgment touches upon fundamental principles governing tenure security, title authenticity, or procedural fairness in workplace dismissal proceedings.\n\n### Statutory Framework Applied\nThe Court grounded its findings on the Land Registration Act 2012, Section 38 of the Limitation of Actions Act (Cap 22), or Sections 41 & 45 of the Employment Act (Cap 226). The bench reiterated that statutory procedures must be strictly honored by all parties.\n\n### Practical Practice Guidance\nConveyancing advocates and human resource counsel are advised to verify that all title documentation and administrative notices strictly adhere to the standards outlined in this judicial precedent.`;
  }
  if (category === 'governance') {
    return `**BAR DIRECTIVES, TECHLAW & GOVERNANCE DIGEST**\n\n**Directive / Ruling:** ${title}\n**Issuing Agency:** ${source} (${formattedDate})\n**Regulatory Scope:** Data Protection, Professional Ethics & Anti-Corruption | ${themeStr}\n\n### Regulatory Overview\nOn ${formattedDate}, regulatory authorities announced enforcement action or statutory guidance regarding **${title}**. This action reinforces oversight in digital privacy compliance, professional conduct of advocates, or public integrity.\n\n### Compliance Mandate & Enforcement\nPursuant to the Data Protection Act 2019, the Advocates Act (Cap 16), or the Anti-Corruption and Economic Crimes Act (ACECA), covered entities must align their operational protocols with statutory disclosure standards and regulatory audits.\n\n### Advisory Note for Practitioners\nLegal departments and registered data controllers are urged to audit internal records, secure necessary statutory certificates, and observe compliance filing deadlines.`;
  }
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
  console.log('[bulletins] Fetching live multi-channel legal bulletins from 15 high-weight channels...');

  try {
    const seenKeys = new Set();
    const feedResults = [];

    // Stagger requests slightly (100ms) to ensure smooth TCP connection handling
    for (let i = 0; i < FEEDS.length; i++) {
      const feedObj = FEEDS[i];
      if (i > 0) {
        await new Promise(r => setTimeout(r, 100));
      }

      try {
        const feedUrl = feedObj.url;
        const feedName = feedObj.name;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        const res = await fetch(feedUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!res.ok) continue;
        const xmlText = await res.text();
        const $ = cheerio.load(xmlText, { xmlMode: true });

        $('item').each((_, el) => {
          const itemEl = $(el);
          let rawTitle = itemEl.find('title').text().trim();
          if (!rawTitle) return;

          const link = itemEl.find('link').text().trim();
          const pubDateStr = itemEl.find('pubDate').text().trim();

          const parts = rawTitle.split(/\s+-\s+(?=[^-]+$)/);
          const title = parts[0].trim();
          const source = parts.length > 1 ? parts[1].trim() : feedName;

          const tKey = title.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 50);
          if (!tKey || seenKeys.has(tKey)) return;
          seenKeys.add(tKey);

          const formattedDate = parsePubDate(pubDateStr);
          const { category, categoryLabel } = categorizeArticle(title, rawTitle);
          const tags = extractTags(title, rawTitle);
          const imageUrl = resolveImage(title, rawTitle);
          const articleId = 'bulletin-live-' + crypto.createHash('md5').update(tKey).digest('hex').substring(0, 10);
          const summary = `${title}. Reported by ${source} on ${formattedDate}.`;
          const content = generateBulletinContent(title, source, formattedDate, tags, category);

          feedResults.push({
            id: articleId,
            title,
            url: link || 'http://kenyalaw.org',
            sourceUrl: link || 'http://kenyalaw.org',
            source,
            date: formattedDate,
            category,
            categoryLabel,
            readTime: '4 min read',
            impact: (category === 'judiciary' || category === 'legislation' || category === 'commercial') ? 'High' : 'Medium',
            tags,
            summary,
            content,
            imageUrl
          });
        });
      } catch (err) {
        console.warn(`[bulletins] Feed note (${feedObj.name}):`, err.message);
      }
    }

    if (feedResults.length > 0) {
      // Sort newest first
      feedResults.sort((a, b) => b.date.localeCompare(a.date));
      const topBulletins = feedResults.slice(0, 250);

      const outputData = {
        updatedAt: new Date().toISOString(),
        total: topBulletins.length,
        bulletins: topBulletins
      };

      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }

      fs.writeFileSync(OUTPUT_FILE, JSON.stringify(outputData, null, 2), 'utf8');
      console.log(`[bulletins] Successfully saved ${topBulletins.length} diverse legal bulletins to ${OUTPUT_FILE}`);
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
        if (ageMs > 4 * 60 * 60 * 1000) { // 4 hours
          shouldRun = true;
        }
      } catch (e) {
        shouldRun = true;
      }
    }
  }

  if (shouldRun) {
    setImmediate(() => {
      crawlDailyBulletins().catch(e => console.warn('[bulletins] Async crawl note:', e.message));
    });
  }
}

module.exports = {
  FEEDS,
  crawlDailyBulletins,
  runBulletinCrawlerIfNeeded,
  resolveImage,
  categorizeArticle,
  extractTags,
  parsePubDate
};

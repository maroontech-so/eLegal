require('dotenv').config();

process.on('unhandledRejection', (reason, promise) => {
  console.warn('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Sanitize Cloudinary environment variables before requiring SDK
if (process.env.CLOUDINARY_URL !== undefined) {
  const cUrl = String(process.env.CLOUDINARY_URL).trim();
  if (!cUrl.startsWith('cloudinary://')) {
    delete process.env.CLOUDINARY_URL;
  }
}

const { GoogleGenAI } = require('@google/genai');
const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { execSync } = require('child_process');
const crypto = require('crypto');
const admin = require('firebase-admin');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore: firebaseGetFirestore } = require('firebase-admin/firestore');
const cors = require('cors');
const { v2: cloudinary } = require('cloudinary');
const { classifyQueryOpenSourceML } = require('./src/ml-classifier');

// Initialize Cloudinary safely
function getCloudinary() {
  if (process.env.CLOUDINARY_URL && typeof process.env.CLOUDINARY_URL === 'string' && !process.env.CLOUDINARY_URL.trim().startsWith('cloudinary://')) {
    delete process.env.CLOUDINARY_URL;
  }

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  const validUrl = process.env.CLOUDINARY_URL;

  if (validUrl || (cloudName && apiKey && apiSecret)) {
    try {
      if (cloudName && apiKey && apiSecret) {
        cloudinary.config({
          cloud_name: cloudName,
          api_key: apiKey,
          api_secret: apiSecret,
          secure: true
        });
      }
      return cloudinary;
    } catch (e) {
      console.warn('[cloudinary] Configuration warning:', e.message);
    }
  }
  return null;
}

async function uploadToCloudinaryIfConfigured(contentBufferOrPath, publicId, resourceType = 'raw') {
  try {
    const c = getCloudinary();
    if (!c) return null;

    const safePublicId = String(publicId || '').replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 80) || 'doc';

    return new Promise((resolve) => {
      const uploadOptions = {
        public_id: `elegal_${safePublicId}`,
        resource_type: resourceType,
        overwrite: true
      };

      let bufferToUpload = null;

      if (Buffer.isBuffer(contentBufferOrPath)) {
        bufferToUpload = contentBufferOrPath;
      } else if (typeof contentBufferOrPath === 'string') {
        // If string is an existing file path, upload file
        if (contentBufferOrPath.length < 500 && fs.existsSync(contentBufferOrPath) && fs.statSync(contentBufferOrPath).isFile()) {
          c.uploader.upload(contentBufferOrPath, uploadOptions, (error, result) => {
            if (error) {
              console.warn('[cloudinary] File upload warning:', error.message);
              resolve(null);
            } else {
              console.log('[cloudinary] Uploaded file successfully:', result.secure_url);
              resolve(result.secure_url);
            }
          });
          return;
        } else {
          // It is raw text/HTML string content, convert to Buffer for stream upload
          bufferToUpload = Buffer.from(contentBufferOrPath, 'utf8');
        }
      }

      if (bufferToUpload) {
        const stream = c.uploader.upload_stream(uploadOptions, (error, result) => {
          if (error) {
            console.warn('[cloudinary] Buffer upload warning:', error.message);
            resolve(null);
          } else {
            console.log('[cloudinary] Uploaded buffer successfully:', result.secure_url);
            resolve(result.secure_url);
          }
        });
        stream.end(bufferToUpload);
      } else {
        resolve(null);
      }
    });
  } catch (err) {
    console.warn('[cloudinary] Upload helper warning:', err.message);
    return null;
  }
}

let firestoreInitialized = false;
const rateLimits = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 60;
const app = express();
const PORT = 3000;
const INDEX_FILE = path.join(__dirname, 'search-index.json');
const KEYS_FILE = path.join(__dirname, 'data', 'apikeys.json');

function initLocalKeysStore() {
  const dir = path.join(__dirname, 'data');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(KEYS_FILE)) {
    fs.writeFileSync(KEYS_FILE, JSON.stringify({ userKeys: {} }, null, 2));
  }
}

function getLocalKeys() {
  try {
    initLocalKeysStore();
    const raw = fs.readFileSync(KEYS_FILE, 'utf8');
    return JSON.parse(raw).userKeys || {};
  } catch (e) {
    return {};
  }
}

function saveLocalKeys(userKeys) {
  try {
    initLocalKeysStore();
    fs.writeFileSync(KEYS_FILE, JSON.stringify({ userKeys }, null, 2));
  } catch (e) {
    console.warn('[apikeys] Failed to save local API keys:', e.message);
  }
}

function getFirestore() {
  if (!firestoreInitialized) {
    try {
      if (admin.getApps().length === 0) {
        let initialized = false;
        const projectId = process.env.FIREBASE_PROJECT_ID || 'elegal-v1';

        const serviceAccountEnv = process.env.FIREBASE_SERVICE_ACCOUNT;
        if (serviceAccountEnv) {
          try {
            const sa = JSON.parse(serviceAccountEnv);
            if (sa.private_key && !sa.private_key.includes('YOUR_')) {
              admin.initializeApp({
                credential: admin.cert(sa),
                projectId
              });
              console.log('Firebase Admin SDK initialized via env variable');
              initialized = true;
            }
          } catch (e) {
            console.warn('Failed to parse FIREBASE_SERVICE_ACCOUNT env var:', e.message);
          }
        }

        if (!initialized) {
          const serviceAccountPath = path.join(__dirname, 'firebase-service-account.json');
          if (fs.existsSync(serviceAccountPath)) {
            try {
              const sa = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
              if (sa.private_key && !sa.private_key.includes('YOUR_')) {
                admin.initializeApp({
                  credential: admin.cert(sa),
                  projectId
                });
                console.log('Firebase Admin SDK initialized via service account');
                initialized = true;
              } else {
                console.warn('firebase-service-account.json contains placeholder credentials');
              }
            } catch (e) {
              console.warn('Failed to read service account:', e.message);
            }
          }
        }

        if (!initialized) {
          try {
            admin.initializeApp({
              credential: admin.applicationDefault(),
              projectId
            });
            console.log('Firebase Admin SDK initialized via application default credentials');
            initialized = true;
          } catch (e) {
            console.warn('Firebase Admin SDK not initialized via application default credentials:', e.message);
          }
        }

        if (!initialized) {
          console.warn('Firebase Admin SDK not initialized — using local API key store');
          firestoreInitialized = true;
          return null;
        }
      }
      firestoreInitialized = true;
      console.log('[firebase] Firestore client ready');
    } catch (e) {
      console.warn('Firebase Admin SDK initialization failed:', e.message);
      return null;
    }
  }
  return firebaseGetFirestore();
}

async function loadApiKeys() {
  let loadedFromFirestore = false;
  try {
    const db = getFirestore();
    if (db) {
      const snapshot = await db.collection('apikeys').get();
      const promises = [];
      snapshot.forEach(userDoc => {
        promises.push(
          userDoc.ref.collection('keys').get().then(keysSnap => {
            keysSnap.forEach(keyDoc => {
              rateLimits.set(keyDoc.id, { count: 0, resetAt: Date.now() + RATE_LIMIT_WINDOW_MS });
            });
          }).catch(err => {
            console.warn('[apikeys] Subcollection fetch warning:', err.message);
          })
        );
      });
      await Promise.all(promises);
      loadedFromFirestore = true;
      console.log(`Loaded API keys from Firestore`);
    }
  } catch (e) {
    console.warn('[apikeys] Firestore unauthenticated or unavailable:', e.message);
  }

  if (!loadedFromFirestore) {
    const userKeys = getLocalKeys();
    let count = 0;
    Object.values(userKeys).forEach(keys => {
      if (keys && typeof keys === 'object') {
        Object.entries(keys).forEach(([keyId, keyData]) => {
          if (keyData && keyData.isActive) {
            rateLimits.set(keyId, { count: 0, resetAt: Date.now() + RATE_LIMIT_WINDOW_MS });
            count++;
          }
        });
      }
    });
    console.log(`Loaded ${count} active API keys from local key store`);
  }
}

function generateApiKey() {
  return 'el_' + crypto.randomBytes(16).toString('hex');
}

async function createApiKey(label, userId) {
  const key = generateApiKey();
  const now = new Date().toISOString();
  let savedToFirestore = false;

  try {
    const db = getFirestore();
    if (db) {
      const userKeysRef = db.collection('apikeys').doc(userId).collection('keys');
      const existing = await userKeysRef.where('isActive', '==', true).get();
      if (!existing.empty) {
        const oldKey = existing.docs[0];
        await oldKey.ref.update({ isActive: false, replacedAt: now });
        rateLimits.delete(oldKey.id);
      }
      await userKeysRef.doc(key).set({
        label: label || 'default',
        createdAt: now,
        lastUsed: null,
        requestCount: 0,
        isActive: true
      });
      savedToFirestore = true;
    }
  } catch (e) {
    console.warn('[apikeys] Could not save API key to Firestore, using local store:', e.message);
  }

  const userKeys = getLocalKeys();
  if (!userKeys[userId]) userKeys[userId] = {};

  Object.keys(userKeys[userId]).forEach(k => {
    if (userKeys[userId][k] && userKeys[userId][k].isActive) {
      userKeys[userId][k].isActive = false;
      userKeys[userId][k].replacedAt = now;
      rateLimits.delete(k);
    }
  });

  userKeys[userId][key] = {
    label: label || 'default',
    createdAt: now,
    lastUsed: null,
    requestCount: 0,
    isActive: true
  };
  saveLocalKeys(userKeys);

  rateLimits.set(key, { count: 0, resetAt: Date.now() + RATE_LIMIT_WINDOW_MS });
  console.log(`Created API key for user ${userId}: ${key}`);
  return { key, label: label || 'default', createdAt: now };
}

async function validateApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key) {
    return res.status(401).json({ error: 'API key required', code: 'MISSING_API_KEY' });
  }

  let keyData = null;
  let keyDocRef = null;

  try {
    const db = getFirestore();
    if (db) {
      const snapshot = await db.collection('apikeys').get();
      const checks = [];
      snapshot.forEach(userDoc => {
        checks.push(userDoc.ref.collection('keys').doc(key).get());
      });
      const docs = await Promise.all(checks);
      for (const doc of docs) {
        if (doc.exists) {
          keyData = doc.data();
          keyDocRef = doc.ref;
          break;
        }
      }
    }
  } catch (e) {
    // Firestore unavailable/unauthenticated, fall back to local store
  }

  if (!keyData) {
    const userKeys = getLocalKeys();
    for (const uId of Object.keys(userKeys)) {
      if (userKeys[uId] && userKeys[uId][key]) {
        keyData = userKeys[uId][key];
        break;
      }
    }
  }

  if (!keyData || !keyData.isActive) {
    return res.status(401).json({ error: 'Invalid API key', code: 'INVALID_API_KEY' });
  }

  const now = Date.now();
  const limit = rateLimits.get(key) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  if (now > limit.resetAt) {
    limit.count = 0;
    limit.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }
  limit.count++;
  rateLimits.set(key, limit);
  if (limit.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Rate limit exceeded', code: 'RATE_LIMIT_EXCEEDED', resetAt: new Date(limit.resetAt).toISOString() });
  }

  const lastUsed = new Date().toISOString();
  keyData.lastUsed = lastUsed;
  keyData.requestCount = (keyData.requestCount || 0) + 1;

  if (keyDocRef) {
    try {
      await keyDocRef.update({ lastUsed, requestCount: keyData.requestCount });
    } catch (_) {}
  } else {
    const userKeys = getLocalKeys();
    for (const uId of Object.keys(userKeys)) {
      if (userKeys[uId] && userKeys[uId][key]) {
        userKeys[uId][key].lastUsed = lastUsed;
        userKeys[uId][key].requestCount = keyData.requestCount;
        saveLocalKeys(userKeys);
        break;
      }
    }
  }

  req.apiKey = key;
  req.apiKeyInfo = keyData;
  next();
}

app.use(express.static('public'));
app.use('/lib', express.static('public/lib'));
app.use(express.json({ limit: '10mb' }));

app.use(cors({
  origin: true,
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key']
}));

app.options('*', cors());

const pdfCache = new Map();
const PDF_CACHE_TTL = 30 * 60 * 1000;
const PDF_CACHE_MAX_SIZE = 50;

// Persistent Local E-Repository Store
const REPO_DIR = path.join(__dirname, 'data', 'repository');
const REPO_DOCS_DIR = path.join(REPO_DIR, 'docs');
const REPO_INDEX_FILE = path.join(REPO_DIR, 'doc_metadata.json');

function initRepositoryStore() {
  if (!fs.existsSync(REPO_DIR)) {
    fs.mkdirSync(REPO_DIR, { recursive: true });
  }
  if (!fs.existsSync(REPO_DOCS_DIR)) {
    fs.mkdirSync(REPO_DOCS_DIR, { recursive: true });
  }
  if (!fs.existsSync(REPO_INDEX_FILE)) {
    const seedData = {
      docs: [
        {
          id: "const_2010",
          title: "The Constitution of Kenya, 2010",
          label: "Constitution of Kenya, 2010",
          citation: "Constitution of Kenya 2010",
          year: "2010",
          type: "Constitution",
          source: "Kenya Law (eKLR)",
          url: "https://kenyalaw.org/akn/ke/act/2010/constitution/eng@2010-09-03",
          readUrl: "/read.html?title=The%20Constitution%20of%20Kenya%2C%202010&sourceUrl=https%3A%2F%2Fkenyalaw.org%2Fakn%2Fke%2Fact%2F2010%2Fconstitution%2Feng%402010-09-03&year=2010&type=Constitution&source=Kenya%20Law%20(eKLR)",
          sourceUrl: "https://kenyalaw.org/akn/ke/act/2010/constitution/eng@2010-09-03",
          snippets: ["The supreme law of the Republic of Kenya. Article 1: All sovereign power belongs to the people of Kenya."],
          cachedAt: new Date().toISOString()
        },
        {
          id: "penal_code_cap63",
          title: "Penal Code (Cap. 63)",
          label: "Penal Code",
          citation: "Cap. 63",
          year: "1930",
          type: "Legislation",
          source: "Kenya Law (eKLR)",
          url: "https://kenyalaw.org/akn/ke/act/1930/10/eng@2023-12-11",
          readUrl: "/read.html?title=Penal%20Code%20(Cap.%2063)&sourceUrl=https%3A%2F%2Fkenyalaw.org%2Fakn%2Fke%2Fact%2F1930%2F10%2Feng%402023-12-11&year=1930&type=Legislation&source=Kenya%20Law%20(eKLR)",
          sourceUrl: "https://kenyalaw.org/akn/ke/act/1930/10/eng@2023-12-11",
          snippets: ["An Act of Parliament to establish a code of criminal law."],
          cachedAt: new Date().toISOString()
        },
        {
          id: "limitation_act_cap22",
          title: "Limitation of Actions Act (Cap. 22)",
          label: "Limitation of Actions Act",
          citation: "Cap. 22",
          year: "1968",
          type: "Legislation",
          source: "Kenya Law (eKLR)",
          url: "https://kenyalaw.org/akn/ke/act/1968/21/eng@2022-12-31",
          readUrl: "/read.html?title=Limitation%20of%20Actions%20Act%20(Cap.%2022)&sourceUrl=https%3A%2F%2Fkenyalaw.org%2Fakn%2Fke%2Fact%2F1968%2F21%2Feng%402022-12-31&year=1968&type=Legislation&source=Kenya%20Law%20(eKLR)",
          sourceUrl: "https://kenyalaw.org/akn/ke/act/1968/21/eng@2022-12-31",
          snippets: ["An Act of Parliament to prescribe periods of limitation for legal actions, including adverse possession."],
          cachedAt: new Date().toISOString()
        },
        {
          id: "sisto_wambugu_1983",
          title: "Sisto Wambugu v Kamau Njuguna [1983] KECA 69 (KLR)",
          label: "Sisto Wambugu v Kamau Njuguna",
          citation: "Sisto Wambugu v Kamau Njuguna [1983] KECA 69 (KLR)",
          year: "1983",
          type: "Judgment",
          source: "Kenya Law (Court of Appeal)",
          url: "https://kenyalaw.org/akn/ke/judgment/keca/1983/69/eng@1983-11-14",
          readUrl: "/read.html?title=Sisto%20Wambugu%20v%20Kamau%20Njuguna%20%5B1983%5D%20KECA%2069%20(KLR)&sourceUrl=https%3A%2F%2Fkenyalaw.org%2Fakn%2Fke%2Fjudgment%2Fkeca%2F1983%2F69%2Feng%401983-11-14&year=1983&type=Judgment&source=Kenya%20Law%20(Court%20of%20Appeal)",
          sourceUrl: "https://kenyalaw.org/akn/ke/judgment/keca/1983/69/eng@1983-11-14",
          snippets: ["Landmark Court of Appeal judgment on land dispute, limitation period, and adverse possession principles."],
          cachedAt: new Date().toISOString()
        }
      ],
      updatedAt: new Date().toISOString()
    };
    fs.writeFileSync(REPO_INDEX_FILE, JSON.stringify(seedData, null, 2));
  }
}

function getRepositoryDocs() {
  try {
    initRepositoryStore();
    const data = JSON.parse(fs.readFileSync(REPO_INDEX_FILE, 'utf8'));
    return data.docs || [];
  } catch (e) {
    console.error('Error reading repository docs:', e.message);
    return [];
  }
}

function extractYearFromText(text = '') {
  if (!text) return null;
  const matches = text.match(/\b(18|19|20)\d{2}\b/g);
  if (matches) {
    for (const y of matches) {
      const num = parseInt(y, 10);
      if (num >= 1800 && num <= 2026) return y;
    }
  }
  return null;
}

function classifyDocumentType(title = '', citation = '', url = '', text = '') {
  const combined = `${title} ${citation} ${url} ${text}`.toLowerCase();
  if (combined.includes('advisory opinion')) return 'Advisory Opinion';
  if (combined.includes('ruling') || combined.includes('application no')) return 'Ruling';
  if (combined.includes('bill')) return 'Bill';
  if (combined.includes('gazette') || combined.includes('legal notice')) return 'Gazette Notice';
  if (combined.includes('constitution')) return 'Constitution';
  if (combined.includes('act') || combined.includes('statute') || combined.includes('cap.') || combined.includes('cap ') || combined.includes('section ')) return 'Legislation';
  if (combined.includes('judgment') || combined.includes('judgement') || combined.includes(' v ') || combined.includes(' v. ') || combined.includes(' versus ') || combined.includes('[klr]') || combined.includes('appeal')) return 'Judgment';
  return 'Precedent';
}

function parseSourceLabel(url = '', rawSource = '') {
  if (rawSource === 'kenyalaw' || (url && url.includes('kenyalaw.org'))) {
    if (url.includes('/kesc/')) return 'Kenya Law (Supreme Court)';
    if (url.includes('/keca/')) return 'Kenya Law (Court of Appeal)';
    if (url.includes('/kehc/')) return 'Kenya Law (High Court)';
    if (url.includes('/keelrc/')) return 'Kenya Law (ELRC)';
    return 'Kenya Law (eKLR)';
  }
  if (url.includes('icc-cpi.int')) return 'International Criminal Court (ICC)';
  if (url.includes('icj-cij.org')) return 'International Court of Justice (ICJ)';
  if (url.includes('irmct.org') || url.includes('unictr')) return 'IRMCT / ICTR / ICTY';
  if (url.includes('supremecourt.uk') || url.includes('gov.uk')) return 'UK Legal Precedents';
  if (url.includes('law.cornell.edu') || url.includes('justia.com')) return 'US Legal Precedents';
  if (url.includes('worldlii.org') || url.includes('bailii.org')) return 'International Precedent';
  return rawSource === 'international' ? 'International Precedent' : (rawSource || 'Legal Repository');
}

function enrichDocumentMetadata(doc) {
  if (!doc) return {};
  const title = doc.title || doc.label || 'Document';
  const citation = doc.citation || title;
  const url = doc.url || doc.sourceUrl || doc.readUrl || '';
  const text = (doc.snippets || []).join(' ') || '';

  const year = doc.year || extractYearFromText(title) || extractYearFromText(citation) || extractYearFromText(url) || extractYearFromText(text) || new Date().getFullYear().toString();
  const type = doc.type || classifyDocumentType(title, citation, url, text);
  const source = parseSourceLabel(url, doc.source);

  let readUrl = doc.readUrl;
  if (!readUrl || !readUrl.startsWith('/read')) {
    readUrl = `/read.html?title=${encodeURIComponent(title)}&sourceUrl=${encodeURIComponent(url)}&year=${encodeURIComponent(year)}&type=${encodeURIComponent(type)}&source=${encodeURIComponent(source)}`;
  } else if (!readUrl.includes('year=')) {
    readUrl += `&year=${encodeURIComponent(year)}&type=${encodeURIComponent(type)}&source=${encodeURIComponent(source)}`;
  }

  return {
    ...doc,
    title,
    label: doc.label || title.replace(/^(The|An|A)\s+/i, '').trim(),
    citation,
    year,
    type,
    source,
    url,
    readUrl
  };
}

function getBrowserHeaders(refererUrl = '') {
  let ref = 'https://kenyalaw.org/';
  if (refererUrl) {
    try { ref = new URL(refererUrl).origin + '/'; } catch (_) {}
  }
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/pdf',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'cross-site',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'Referer': ref
  };
}

function normalizeFetchUrl(urlStr = '') {
  if (!urlStr) return '';
  let normalized = urlStr.trim();
  if (normalized.startsWith('http://kenyalaw.org')) {
    normalized = normalized.replace('http://kenyalaw.org', 'https://kenyalaw.org');
  } else if (normalized.startsWith('http://') && !normalized.includes('localhost') && !normalized.includes('127.0.0.1')) {
    normalized = normalized.replace('http://', 'https://');
  }
  return normalized;
}

function extractPdfUrlFromHtml(rawHtml = '', sourceUrl = '') {
  if (!rawHtml && !sourceUrl) return null;

  const normSource = normalizeFetchUrl(sourceUrl);

  // 1. Direct KenyaLaw caselaw view check: /caselaw/cases/view/123456 -> /caselaw/cases/export/123456/pdf
  if (normSource && normSource.includes('/caselaw/cases/view/')) {
    try {
      const u = new URL(normSource);
      const match = u.pathname.match(/\/caselaw\/cases\/view\/(\d+)/i);
      if (match && match[1]) {
        return `${u.origin}/caselaw/cases/export/${match[1]}/pdf`;
      }
    } catch (_) {}
    const directExport = normSource.replace('/caselaw/cases/view/', '/caselaw/cases/export/').replace(/\/+$/, '') + '/pdf';
    return directExport;
  }

  if (!rawHtml) return null;

  // 2. Check href attributes for pdf/export links
  const matches = Array.from(rawHtml.matchAll(/href=["']([^"']+)["']/gi));
  for (const match of matches) {
    const href = match[1];
    if (href.includes('/export/') && href.toLowerCase().includes('pdf')) {
      try { return new URL(href, normSource || 'https://kenyalaw.org').href; } catch (_) {}
    }
    if (href.toLowerCase().endsWith('.pdf') || href.toLowerCase().includes('.pdf?')) {
      try { return new URL(href, normSource || 'https://kenyalaw.org').href; } catch (_) {}
    }
  }

  // 3. Check for Download PDF button link text
  const downloadMatch = rawHtml.match(/<a[^>]+href=["']([^"']+)["'][^>]*>(?:[\s\S]*?Download PDF[\s\S]*?)<\/a>/i);
  if (downloadMatch && downloadMatch[1]) {
    try { return new URL(downloadMatch[1], normSource || 'https://kenyalaw.org').href; } catch (_) {}
  }

  return null;
}

function saveDocToRepository(docMeta, contentBufferOrString = null, ext = 'txt') {
  try {
    initRepositoryStore();
    const docs = getRepositoryDocs();
    const enriched = enrichDocumentMetadata(docMeta);
    
    const docId = docMeta.id || ('doc_' + crypto.createHash('md5').update(enriched.url || enriched.title).digest('hex').substring(0, 12));
    enriched.id = docId;
    enriched.cachedAt = new Date().toISOString();

    if (contentBufferOrString) {
      const fileName = `${docId}.${ext}`;
      const filePath = path.join(REPO_DOCS_DIR, fileName);
      fs.writeFileSync(filePath, contentBufferOrString);
      enriched.contentFile = fileName;
      enriched.contentType = ext === 'pdf' ? 'application/pdf' : ext === 'html' ? 'text/html' : 'text/plain';

      // Cloudinary async upload of document file
      const resourceType = ext === 'pdf' ? 'raw' : 'auto';
      uploadToCloudinaryIfConfigured(contentBufferOrString, docId, resourceType).then(cloudUrl => {
        if (cloudUrl) {
          enriched.cloudinaryUrl = cloudUrl;
          const currentDocs = getRepositoryDocs();
          const idx = currentDocs.findIndex(d => d.id === docId);
          if (idx >= 0) {
            currentDocs[idx].cloudinaryUrl = cloudUrl;
            fs.writeFileSync(REPO_INDEX_FILE, JSON.stringify({ docs: currentDocs, updatedAt: new Date().toISOString() }, null, 2));
          }
        }
      }).catch(err => console.warn('[cloudinary] Async upload failed:', err.message));
    }

    // Always upload metadata and links as JSON to Cloudinary
    const metaJsonData = {
      id: enriched.id,
      title: enriched.title,
      label: enriched.label,
      citation: enriched.citation,
      year: enriched.year,
      type: enriched.type,
      source: enriched.source,
      url: enriched.url,
      sourceUrl: enriched.sourceUrl || enriched.url,
      readUrl: enriched.readUrl,
      pdfUrl: enriched.pdfUrl || (enriched.contentType === 'application/pdf' ? (enriched.cloudinaryUrl || `/api/pdf-proxy?sourceUrl=${encodeURIComponent(enriched.url)}`) : null),
      contentFile: enriched.contentFile || null,
      contentType: enriched.contentType || null,
      cloudinaryUrl: enriched.cloudinaryUrl || null,
      cachedAt: enriched.cachedAt,
      links: {
        original: enriched.url,
        read: enriched.readUrl,
        pdf: enriched.pdfUrl || null,
        cloudinaryDoc: enriched.cloudinaryUrl || null
      }
    };

    const metaBuffer = Buffer.from(JSON.stringify(metaJsonData, null, 2), 'utf8');
    uploadToCloudinaryIfConfigured(metaBuffer, `${docId}_metadata`, 'raw').then(cloudMetaUrl => {
      if (cloudMetaUrl) {
        enriched.cloudinaryMetaUrl = cloudMetaUrl;
        const currentDocs = getRepositoryDocs();
        const idx = currentDocs.findIndex(d => d.id === docId);
        if (idx >= 0) {
          currentDocs[idx].cloudinaryMetaUrl = cloudMetaUrl;
          fs.writeFileSync(REPO_INDEX_FILE, JSON.stringify({ docs: currentDocs, updatedAt: new Date().toISOString() }, null, 2));
        }
      }
    }).catch(err => console.warn('[cloudinary] Metadata JSON upload failed:', err.message));

    const existingIdx = docs.findIndex(d => d.id === docId || (d.url && d.url === enriched.url));
    if (existingIdx >= 0) {
      docs[existingIdx] = { ...docs[existingIdx], ...enriched };
    } else {
      docs.unshift(enriched);
    }

    fs.writeFileSync(REPO_INDEX_FILE, JSON.stringify({ docs, updatedAt: new Date().toISOString() }, null, 2));

    return enriched;
  } catch (e) {
    console.error('saveDocToRepository error:', e.message);
    return docMeta;
  }
}

app.get('/api/pdf-proxy', async (req, res) => {
  const sourceUrl = req.query.sourceUrl;
  if (!sourceUrl) {
    return res.status(400).json({ error: 'No source URL provided' });
  }

  const normSource = normalizeFetchUrl(sourceUrl);

  // Check if cached in repository with Cloudinary or local file
  const repoDocs = getRepositoryDocs();
  const cachedMeta = repoDocs.find(d => d.url === sourceUrl || d.sourceUrl === sourceUrl || d.url === normSource || (d.id && sourceUrl.includes(d.id)));

  if (cachedMeta && cachedMeta.cloudinaryUrl && cachedMeta.contentType === 'application/pdf') {
    console.log('[pdf-proxy] Serving directly from Cloudinary URL:', cachedMeta.cloudinaryUrl);
    return res.redirect(cachedMeta.cloudinaryUrl);
  }

  if (cachedMeta && cachedMeta.contentFile && cachedMeta.contentType === 'application/pdf') {
    const filePath = path.join(REPO_DOCS_DIR, cachedMeta.contentFile);
    if (fs.existsSync(filePath)) {
      res.setHeader('Content-Type', 'application/pdf');
      return res.sendFile(filePath);
    }
  }

  const cacheKey = normSource;
  const now = Date.now();

  if (pdfCache.has(cacheKey)) {
    const cached = pdfCache.get(cacheKey);
    if (now - cached.timestamp < PDF_CACHE_TTL && cached.contentType === 'application/pdf') {
      res.setHeader('Content-Type', 'application/pdf');
      return res.send(cached.data);
    }
    pdfCache.delete(cacheKey);
  }

  try {
    let targetPdfUrl = normSource;

    if (normSource.includes('/caselaw/cases/view/')) {
      targetPdfUrl = extractPdfUrlFromHtml('', normSource) || normSource;
    }

    let response = await fetch(targetPdfUrl, {
      headers: getBrowserHeaders(targetPdfUrl),
      redirect: 'follow'
    });

    if (!response.ok && targetPdfUrl !== normSource) {
      // Retry with original normalized URL
      targetPdfUrl = normSource;
      response = await fetch(targetPdfUrl, {
        headers: getBrowserHeaders(targetPdfUrl),
        redirect: 'follow'
      });
    }

    if (!response.ok) {
      return res.status(502).json({ error: `Failed to fetch document (status ${response.status})` });
    }

    let contentType = response.headers.get('content-type') || '';
    let arrayBuffer = await response.arrayBuffer();
    let pdfBuffer = Buffer.from(arrayBuffer);

    // If fetched content is HTML (e.g. view page), try to scrape PDF export URL from HTML
    if (!contentType.includes('pdf') && !pdfBuffer.toString('utf8', 0, 10).startsWith('%PDF-')) {
      const htmlText = pdfBuffer.toString('utf8');
      const foundPdfUrl = extractPdfUrlFromHtml(htmlText, normSource);
      if (foundPdfUrl && foundPdfUrl !== targetPdfUrl) {
        console.log('[pdf-proxy] Scraped PDF export URL from HTML page:', foundPdfUrl);
        const retryResp = await fetch(foundPdfUrl, {
          headers: getBrowserHeaders(foundPdfUrl),
          redirect: 'follow'
        });
        if (retryResp.ok) {
          const retryBuffer = Buffer.from(await retryResp.arrayBuffer());
          if (retryBuffer.toString('utf8', 0, 10).startsWith('%PDF-')) {
            pdfBuffer = retryBuffer;
            contentType = 'application/pdf';
            targetPdfUrl = foundPdfUrl;
          }
        }
      }
    }

    // Verify PDF header magic bytes %PDF-
    if (!pdfBuffer.toString('utf8', 0, 10).startsWith('%PDF-')) {
      console.warn('[pdf-proxy] Source URL is not a valid PDF file.');
      return res.status(404).json({
        error: 'No valid PDF file found for this document',
        message: 'The requested legal record is available in text format. Please use Text View.'
      });
    }

    if (pdfCache.size >= PDF_CACHE_MAX_SIZE) {
      const oldestKey = pdfCache.keys().next().value;
      pdfCache.delete(oldestKey);
    }
    pdfCache.set(cacheKey, { data: pdfBuffer, contentType: 'application/pdf', timestamp: now });

    // Save actual PDF to repository & upload to Cloudinary
    const docMeta = enrichDocumentMetadata({
      title: normSource.split('/').pop() || 'PDF Document',
      url: normSource,
      pdfUrl: targetPdfUrl
    });
    saveDocToRepository(docMeta, pdfBuffer, 'pdf');

    res.setHeader('Content-Type', 'application/pdf');
    res.send(pdfBuffer);
  } catch (e) {
    console.error('PDF proxy error:', e.message);
    res.status(502).json({ error: 'Failed to fetch PDF document', message: e.message });
  }
});

function cleanLegalDocumentContent(rawHtml = '') {
  if (!rawHtml) return { bodyHtml: '', plainText: '' };

  let html = rawHtml
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<form[\s\S]*?<\/form>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '');

  // Strip non-content UI containers, header/footer/nav/sidebar wrappers
  html = html
    .replace(/<div[^>]*class=["'][^"']*(?:site-header|site-footer|header|footer|nav|navigation|menu|sidebar|cookie|banner|toolbar|post-header|breadcrumb|search-form|actions-bar|social-share|share-buttons|comments|ad-container|advertisement|related-posts|popup|modal|top-bar|bottom-bar)[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/<section[^>]*class=["'][^"']*(?:header|footer|nav|navigation|menu|sidebar|cookie|banner|toolbar|breadcrumb|comments|ads|related)[^"']*["'][^>]*>[\s\S]*?<\/section>/gi, '');

  // Find "Skip to document content" anchor or text
  const skipMatch = html.match(/(?:Skip to document content|Skip to main content|Skip to content)/i);
  if (skipMatch) {
    const idx = html.indexOf(skipMatch[0]);
    html = html.substring(idx + skipMatch[0].length);
  }

  // Locate the start of main document content container
  const containerMatch = html.match(/<(?:article|main|div)[^>]*(?:class|id|role)=["'][^"']*(?:post-content|judgment|akn-judgment|akn-act|statute-content|document-content|entry-content|article-body|content-body|body-text|case-details|doc-details|main-content|main)[^"']*["'][^>]*>/i);

  let bodyHtml = html;
  if (containerMatch && containerMatch.index !== undefined && containerMatch.index >= 0) {
    const subHtml = html.substring(containerMatch.index);
    const footerIdx = subHtml.search(/<footer|<div[^>]*class=["'][^"']*(?:site-footer|footer|comments|related-posts)[^"']/i);
    if (footerIdx > 300) {
      bodyHtml = subHtml.substring(0, footerIdx);
    } else {
      bodyHtml = subHtml;
    }
  }

  // Convert to plain text & clean residual web boilerplate
  let plainText = bodyHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  plainText = plainText
    .replace(/^.*?Skip to (?:document )?content\s*/i, '')
    .replace(/Download PDF \(\d+(\.\d+)? KB\)/gi, '')
    .replace(/Report Report a problem/gi, '')
    .replace(/Find in document text\.\.\./gi, '')
    .replace(/A-\s*A\+\s*Copy text\s*Print/gi, '')
    .replace(/Copy citation/gi, '')
    .replace(/Media Neutral Citation/gi, '')
    .replace(/©\s*\d{4}.*$/gi, '')
    .replace(/All rights reserved.*$/gi, '')
    .trim();

  if (!plainText || plainText.length < 20) {
    plainText = rawHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  return { bodyHtml, plainText };
}

app.get('/read/:filename', async (req, res) => {
  const filename = req.params.filename;
  const title = req.query.title || '';
  const sourceUrl = req.query.sourceUrl || '';
  const raw = req.query.raw === '1';
  const acceptHeader = req.headers.accept || '';

  if (raw || acceptHeader.includes('application/pdf')) {
    if (!sourceUrl) {
      return res.status(400).json({ error: 'No source URL provided' });
    }
    return res.redirect(`/api/pdf-proxy?sourceUrl=${encodeURIComponent(sourceUrl)}`);
  }

  res.sendFile(path.join(__dirname, 'public', 'read.html'));
});

app.get('/api/document-content', async (req, res) => {
  const sourceUrl = req.query.sourceUrl || req.query.url;
  const reqTitle = req.query.title || 'Document';
  const reqYear = req.query.year || '';
  const reqType = req.query.type || '';
  const reqSource = req.query.source || '';

  if (!sourceUrl) {
    return res.status(400).json({ error: 'No source URL provided' });
  }

  const normSource = normalizeFetchUrl(sourceUrl);

  // 1. Check persistent e-repository first!
  const repoDocs = getRepositoryDocs();
  const cachedMeta = repoDocs.find(d => d.url === sourceUrl || d.sourceUrl === sourceUrl || d.url === normSource || (d.id && sourceUrl.includes(d.id)));

  if (cachedMeta && cachedMeta.contentFile) {
    const filePath = path.join(REPO_DOCS_DIR, cachedMeta.contentFile);
    if (fs.existsSync(filePath)) {
      try {
        const fileContent = fs.readFileSync(filePath, 'utf8');
        const { bodyHtml, plainText } = cleanLegalDocumentContent(fileContent);
        return res.json({
          cached: true,
          cloudinaryUrl: cachedMeta.cloudinaryUrl || null,
          isPdf: cachedMeta.contentType === 'application/pdf',
          pdfUrl: cachedMeta.contentType === 'application/pdf' ? (cachedMeta.cloudinaryUrl || `/api/pdf-proxy?sourceUrl=${encodeURIComponent(normSource)}`) : null,
          title: cachedMeta.title,
          label: cachedMeta.label,
          citation: cachedMeta.citation,
          year: cachedMeta.year,
          type: cachedMeta.type,
          source: cachedMeta.source,
          url: cachedMeta.url,
          sourceUrl: cachedMeta.sourceUrl || cachedMeta.url,
          text: plainText || fileContent,
          html: bodyHtml || fileContent
        });
      } catch (e) {
        console.warn('Failed to read cached document file:', e.message);
      }
    }
  }

  // 2. Direct PDF export check for Kenya Law or caselaw export links
  const directExportPdfUrl = extractPdfUrlFromHtml('', normSource);
  if (directExportPdfUrl) {
    try {
      const pdfResp = await fetch(directExportPdfUrl, {
        headers: getBrowserHeaders(directExportPdfUrl),
        redirect: 'follow'
      });
      if (pdfResp.ok) {
        const pdfBuffer = Buffer.from(await pdfResp.arrayBuffer());
        if (pdfBuffer.toString('utf8', 0, 10).startsWith('%PDF-')) {
          console.log('[document-content] Successfully downloaded direct PDF export:', directExportPdfUrl);
          const docMeta = enrichDocumentMetadata({
            title: reqTitle,
            url: normSource,
            pdfUrl: directExportPdfUrl,
            year: reqYear,
            type: reqType,
            source: reqSource || parseSourceLabel(normSource, 'kenyalaw')
          });
          const saved = saveDocToRepository(docMeta, pdfBuffer, 'pdf');
          return res.json({
            isPdf: true,
            hasPdf: true,
            pdfUrl: `/api/pdf-proxy?sourceUrl=${encodeURIComponent(directExportPdfUrl)}`,
            cloudinaryUrl: saved.cloudinaryUrl || null,
            cloudinaryMetaUrl: saved.cloudinaryMetaUrl || null,
            ...docMeta
          });
        }
      }
    } catch (exportErr) {
      console.warn('[document-content] Direct PDF export fetch attempt failed:', exportErr.message);
    }
  }

  // 3. Fetch HTML document from external source with browser headers
  try {
    const response = await fetch(normSource, {
      headers: getBrowserHeaders(normSource),
      redirect: 'follow'
    });

    if (!response.ok) {
      const docMeta = enrichDocumentMetadata({
        title: reqTitle,
        url: normSource,
        year: reqYear,
        type: reqType,
        source: reqSource
      });
      return res.json({
        isPdf: false,
        hasPdf: false,
        fallback: true,
        ...docMeta,
        text: `Unable to fetch direct content from source (${response.status}). You can click "Original source" above to view it on the official site.`,
        html: `<p>Unable to fetch direct content from source (${response.status}). You can click "Original source" above to view it on the official site.</p>`
      });
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('pdf') || normSource.endsWith('.pdf')) {
      const buffer = Buffer.from(await response.arrayBuffer());
      const docMeta = enrichDocumentMetadata({
        title: reqTitle,
        url: normSource,
        year: reqYear,
        type: reqType,
        source: reqSource
      });
      const saved = saveDocToRepository(docMeta, buffer, 'pdf');
      return res.json({
        isPdf: true,
        hasPdf: true,
        cloudinaryUrl: saved.cloudinaryUrl || null,
        pdfUrl: saved.cloudinaryUrl || `/api/pdf-proxy?sourceUrl=${encodeURIComponent(normSource)}`,
        ...docMeta
      });
    }

    // HTML Web Page
    const rawHtml = await response.text();
    
    // Check if body is PDF content disguised as HTML
    if (rawHtml.startsWith('%PDF-')) {
      const buffer = Buffer.from(rawHtml, 'utf8');
      const docMeta = enrichDocumentMetadata({
        title: reqTitle,
        url: normSource,
        year: reqYear,
        type: reqType,
        source: reqSource
      });
      const saved = saveDocToRepository(docMeta, buffer, 'pdf');
      return res.json({
        isPdf: true,
        hasPdf: true,
        cloudinaryUrl: saved.cloudinaryUrl || null,
        pdfUrl: saved.cloudinaryUrl || `/api/pdf-proxy?sourceUrl=${encodeURIComponent(normSource)}`,
        ...docMeta
      });
    }

    // Clean HTML & extract pure legal text content
    const { bodyHtml, plainText } = cleanLegalDocumentContent(rawHtml);

    const info = extractKenyaLawDocumentInfo(rawHtml, normSource);
    const title = info.title || reqTitle;
    const citation = info.citation || title;

    // Check if HTML contains a downloadable PDF export link
    const scrapedPdfUrl = extractPdfUrlFromHtml(rawHtml, normSource);

    const docMeta = enrichDocumentMetadata({
      title,
      citation,
      url: normSource,
      pdfUrl: scrapedPdfUrl || null,
      year: reqYear || extractYearFromText(plainText) || extractYearFromText(title),
      type: reqType || classifyDocumentType(title, citation, normSource, plainText),
      source: reqSource || parseSourceLabel(normSource, 'kenyalaw'),
      snippets: [plainText.substring(0, 300)]
    });

    const saved = saveDocToRepository(docMeta, plainText, 'txt');

    const isPdfDoc = !!scrapedPdfUrl;
    const activePdfUrl = scrapedPdfUrl 
      ? `/api/pdf-proxy?sourceUrl=${encodeURIComponent(scrapedPdfUrl)}` 
      : null;

    return res.json({
      isPdf: isPdfDoc,
      hasPdf: isPdfDoc,
      pdfUrl: activePdfUrl,
      cloudinaryUrl: saved.cloudinaryUrl || null,
      cloudinaryMetaUrl: saved.cloudinaryMetaUrl || null,
      ...docMeta,
      text: plainText,
      html: bodyHtml
    });
  } catch (e) {
    console.error('Document content fetch error:', e.message);
    const docMeta = enrichDocumentMetadata({
      title: reqTitle,
      url: normSource,
      year: reqYear,
      type: reqType,
      source: reqSource
    });
    return res.json({
      isPdf: false,
      hasPdf: false,
      fallback: true,
      ...docMeta,
      text: `Error fetching content: ${e.message}. Click "Original source" to view the original web page.`,
      html: `<p>Error fetching content: ${e.message}. Click "Original source" to view the original web page.</p>`
    });
  }
});

function generateNativeLegalBrief({ title = 'Legal Document', citation = '', year = '', type = '', sourceUrl = '', text = '' }) {
  const docText = (text || '').trim();
  
  if (!docText) {
    return `
      <div style="font-family: system-ui, -apple-system, sans-serif;">
        <h4 style="color: #0f172a; border-bottom: 2px solid #cbd5e1; padding-bottom: 6px; margin-top: 0;">I. CASE / STATUTE IDENTIFIER</h4>
        <p><strong>Title:</strong> ${title}<br>
        <strong>Citation:</strong> ${citation || 'Official Citation Pending'}<br>
        <strong>Jurisdiction / Year:</strong> ${year || 'Kenya/International'} | <strong>Classification:</strong> ${type || 'Legal Document'}</p>
        
        <h4 style="color: #0f172a; border-bottom: 2px solid #cbd5e1; padding-bottom: 6px;">II. SUMMARY NOTICE</h4>
        <p>Full text document content is directly accessible via the primary PDF/Reader view above. Click <em>"Original Source"</em> to inspect the verbatim judicial gazette or court report.</p>
      </div>
    `;
  }

  // Segment text into distinct sentences for precision NLP extraction
  const rawSentences = docText.replace(/\r\n/g, '\n').split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 20);

  const holdings = [];
  const facts = [];
  const issues = [];
  const provisions = [];
  const precedents = [];
  const orders = [];

  const holdingsRegex = /\b(held|holding|we hold|court finds|determined that|ratio decidendi|declared that|it is hereby ordered|concludes that|erred in law|finding of)\b/i;
  const factsRegex = /\b(appellant|respondent|plaintiff|defendant|applicant|originating summons|affidavit|dispute|filed on|pleadings|entered into|contract|transaction|police|arrested|property|title deed)\b/i;
  const issuesRegex = /\b(whether|issue for determination|question before|falls to be decided|point of law|constitutionality|jurisdiction|locus standi|cause of action)\b/i;
  const provisionsRegex = /\b(section|article|cap\.|statute|act 20\d\d|act, 19\d\d|order \d|rule \d|clause|schedule|constitution)\b/i;
  const precedentsRegex = /(\[\d{4}\]| v | vs | eKLR | kehc | keca | kesc | ac | qb | ke\d{4}| citation)/i;
  const ordersRegex = /\b(appeal is (allowed|dismissed)|judgment (entered|rendered)|costs (awarded|shall follow)|injunction (granted|refused)|struck out|order accordingly|decree|remanded|quashed)\b/i;

  rawSentences.forEach(s => {
    const cleanS = s.trim();
    if (holdingsRegex.test(cleanS) && holdings.length < 5) holdings.push(cleanS);
    else if (issuesRegex.test(cleanS) && issues.length < 4) issues.push(cleanS);
    else if (ordersRegex.test(cleanS) && orders.length < 3) orders.push(cleanS);
    else if (provisionsRegex.test(cleanS) && provisions.length < 6) provisions.push(cleanS);
    else if (precedentsRegex.test(cleanS) && precedents.length < 5) precedents.push(cleanS);
    else if (factsRegex.test(cleanS) && facts.length < 5) facts.push(cleanS);
  });

  // Fallbacks using top sentences if specific regex didn't catch enough
  if (facts.length === 0 && rawSentences.length > 0) facts.push(...rawSentences.slice(0, 3));
  if (holdings.length === 0 && rawSentences.length > 3) holdings.push(...rawSentences.slice(3, 6));

  const formatList = (arr) => arr.length > 0 
    ? `<ul style="margin: 6px 0 12px 18px; padding: 0;">${arr.map(item => `<li style="margin-bottom: 6px; line-height: 1.5; color: #1e293b;">${item}</li>`).join('')}</ul>`
    : `<p style="color: #64748b; font-style: italic; margin-top: 4px;">Direct statutory or judicial text extract available in full document view.</p>`;

  return `
    <div style="font-family: system-ui, -apple-system, sans-serif; line-height: 1.6; color: #0f172a;">
      <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-left: 4px solid #1e3a8a; padding: 12px 16px; border-radius: 6px; margin-bottom: 16px;">
        <h3 style="margin: 0 0 4px 0; font-size: 1.1rem; color: #0f172a;">${title}</h3>
        <div style="font-size: 0.85rem; color: #475569;">
          <strong>Citation:</strong> ${citation || 'Official Citation In Record'} &nbsp;|&nbsp; 
          <strong>Year:</strong> ${year || 'Recorded'} &nbsp;|&nbsp; 
          <strong>Category:</strong> ${type || 'Judicial Precedent / Act'}
        </div>
      </div>

      <h4 style="color: #1e3a8a; border-bottom: 1.5px solid #cbd5e1; padding-bottom: 4px; margin: 16px 0 8px 0; font-size: 0.95rem; text-transform: uppercase; letter-spacing: 0.5px;">I. MATERIAL FACTS & PROCEDURAL BACKGROUND</h4>
      ${formatList(facts)}

      <h4 style="color: #1e3a8a; border-bottom: 1.5px solid #cbd5e1; padding-bottom: 4px; margin: 16px 0 8px 0; font-size: 0.95rem; text-transform: uppercase; letter-spacing: 0.5px;">II. LEGAL ISSUES BEFORE THE COURT / STATUTORY SCOPE</h4>
      ${formatList(issues)}

      <h4 style="color: #1e3a8a; border-bottom: 1.5px solid #cbd5e1; padding-bottom: 4px; margin: 16px 0 8px 0; font-size: 0.95rem; text-transform: uppercase; letter-spacing: 0.5px;">III. RATIO DECIDENDI & HOLDINGS (BINDING LEGAL RULE)</h4>
      ${formatList(holdings)}

      <h4 style="color: #1e3a8a; border-bottom: 1.5px solid #cbd5e1; padding-bottom: 4px; margin: 16px 0 8px 0; font-size: 0.95rem; text-transform: uppercase; letter-spacing: 0.5px;">IV. STATUTORY PROVISIONS & CITED AUTHORITIES</h4>
      ${formatList([...provisions, ...precedents].slice(0, 7))}

      <h4 style="color: #1e3a8a; border-bottom: 1.5px solid #cbd5e1; padding-bottom: 4px; margin: 16px 0 8px 0; font-size: 0.95rem; text-transform: uppercase; letter-spacing: 0.5px;">V. DISPOSITION, ORDERS & ADVOCATE BRIEFING NOTES</h4>
      ${formatList(orders.length > 0 ? orders : [`This document serves as binding/persuasive authority under ${type || 'applicable law'}. When citing in court pleadings or law school exams, cross-reference exact paragraph citations from full text.`])}
    </div>
  `;
}

// ── Daily 5-Request AI Rate Limiter per Person/IP ──
const aiDailyUsageTracker = new Map();

function enforceAiDailyLimit(req, res) {
  const clientIp = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1').split(',')[0].trim();
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const trackerKey = `${clientIp}_${today}`;

  const usageCount = aiDailyUsageTracker.get(trackerKey) || 0;
  if (usageCount >= 5) {
    res.status(429).json({
      error: 'Daily AI Limit Reached (5/5)',
      message: 'You have reached your daily quota of 5 AI queries today to protect Gemini server limits. Your quota resets at midnight.',
      dailyLimit: 5,
      remaining: 0,
      resetDate: today
    });
    return false;
  }

  aiDailyUsageTracker.set(trackerKey, usageCount + 1);
  res.setHeader('X-AI-Daily-Limit', '5');
  res.setHeader('X-AI-Daily-Remaining', String(5 - (usageCount + 1)));
  return true;
}

app.post('/api/summarize-doc', async (req, res) => {
  if (!enforceAiDailyLimit(req, res)) return;
  const { title = 'Legal Document', sourceUrl = '', text = '', year = '', type = '', citation = '' } = req.body || {};

  const docText = text ? text.substring(0, 15000) : '';

  // 1. Try Gemini API first if available
  const ai = getAiClient();
  if (ai) {
    const models = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'];
    for (const model of models) {
      try {
        const prompt = `You are eLegal Senior High Court Research Clerk & Law Reporter.
Generate a 100% substantive, lawyer and law-student friendly Legal Brief for this document.

CRITICAL MANDATES FOR HIGH-DENSITY LEGAL BRIEF:
1. STRICT ZERO BLUFF / ZERO FLUFF RULE: NO generic preamble, NO introductory conversational commentary ("Here is a brief...", "In conclusion...", "It is important to note...").
2. USE FORMAL JUDICIAL TERMINOLOGY appropriate for Advocates, Judges, Law Students, and Bar Examination preparation.
3. EXTRACT ACCURATE MATERIAL FACTS, RATIO DECIDENDI, STATUTORY ARTICLES/SECTIONS, AND COURT ORDERS FROM THE TEXT.

DOCUMENT METADATA:
- Title: ${title}
- Official Citation: ${citation}
- Year/Date: ${year}
- Type/Nature: ${type}
- Source URL: ${sourceUrl}

DOCUMENT TEXT EXCERPT:
${docText || 'No full text available. Synthesize strict legal brief from title, citation, and official metadata.'}

Respond in clean HTML using this exact structure:
<div style="font-family: system-ui, -apple-system, sans-serif; line-height: 1.6; color: #0f172a;">
  <div style="background: #f8fafc; border: 1px solid #cbd5e1; border-left: 4px solid #1e3a8a; padding: 12px 16px; border-radius: 6px; margin-bottom: 16px;">
    <h3 style="margin: 0 0 4px 0; font-size: 1.1rem; color: #0f172a;">${title}</h3>
    <div style="font-size: 0.85rem; color: #475569;">
      <strong>Citation:</strong> ${citation || 'Official Record'} | <strong>Year:</strong> ${year || 'N/A'} | <strong>Classification:</strong> ${type || 'Legal Authority'}
    </div>
  </div>

  <h4 style="color: #1e3a8a; border-bottom: 1.5px solid #cbd5e1; padding-bottom: 4px; margin: 16px 0 8px 0; font-size: 0.95rem; text-transform: uppercase;">I. MATERIAL FACTS & PROCEDURAL HISTORY</h4>
  <ul style="margin: 6px 0 12px 18px; padding: 0;">
    <li>Exact factual background, party claims, procedural path.</li>
  </ul>

  <h4 style="color: #1e3a8a; border-bottom: 1.5px solid #cbd5e1; padding-bottom: 4px; margin: 16px 0 8px 0; font-size: 0.95rem; text-transform: uppercase;">II. LEGAL ISSUES BEFORE THE COURT / LEGISLATIVE INTENT</h4>
  <ul style="margin: 6px 0 12px 18px; padding: 0;">
    <li>Numbered legal questions framed clearly for litigation or exam analysis.</li>
  </ul>

  <h4 style="color: #1e3a8a; border-bottom: 1.5px solid #cbd5e1; padding-bottom: 4px; margin: 16px 0 8px 0; font-size: 0.95rem; text-transform: uppercase;">III. RATIO DECIDENDI & HOLDING (BINDING RULE OF LAW)</h4>
  <ul style="margin: 6px 0 12px 18px; padding: 0;">
    <li>Core holding, ratio decidendi, and legal principles established.</li>
  </ul>

  <h4 style="color: #1e3a8a; border-bottom: 1.5px solid #cbd5e1; padding-bottom: 4px; margin: 16px 0 8px 0; font-size: 0.95rem; text-transform: uppercase;">IV. STATUTORY PROVISIONS & PRECEDENTS CITED</h4>
  <ul style="margin: 6px 0 12px 18px; padding: 0;">
    <li>Specific Act sections, Constitutional Articles, and cited case laws.</li>
  </ul>

  <h4 style="color: #1e3a8a; border-bottom: 1.5px solid #cbd5e1; padding-bottom: 4px; margin: 16px 0 8px 0; font-size: 0.95rem; text-transform: uppercase;">V. FINAL DISPOSITION, ORDERS & ADVOCATE BRIEFING NOTES</h4>
  <ul style="margin: 6px 0 12px 18px; padding: 0;">
    <li>Court orders, costs, and practical advice on how to cite this precedent in skeleton arguments or law school exams.</li>
  </ul>
</div>`;

        const response = await ai.models.generateContent({
          model,
          contents: prompt,
          config: { temperature: 0.1 }
        });

        let summaryHtml = response.text || '';
        summaryHtml = summaryHtml.replace(/```html/gi, '').replace(/```/g, '').trim();

        if (summaryHtml && summaryHtml.length > 100) {
          return res.json({
            success: true,
            source: 'ai_lawyer_brief',
            summaryHtml
          });
        }
      } catch (err) {
        console.warn(`[summarize-doc] Gemini call failed on ${model}:`, err.message);
      }
    }
  }

  // 2. Standalone Native Legal NLP Brief Generator (Zero API / Zero Cost)
  const nativeBriefHtml = generateNativeLegalBrief({ title, citation, year, type, sourceUrl, text: docText });

  return res.json({
    success: true,
    source: 'native_nlp_brief',
    summaryHtml: nativeBriefHtml
  });
});

app.get('/api/repository/docs', (req, res) => {
  try {
    const docs = getRepositoryDocs();
    res.json({ docs, total: docs.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function fetchUrl(url) {
  const targetUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  const transport = targetUrl.startsWith('https://') ? https : http;

  return new Promise((resolve, reject) => {
    const request = transport.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; eLegal/1.0)',
        'Accept': 'text/plain,text/html,*/*',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(fetchUrl(new URL(res.headers.location, targetUrl).toString()));
        return;
      }

      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });

    request.on('error', (err) => {
      console.error('fetchUrl error:', err.message);
      reject(err);
    });
  });
}

function fetchJson(url) {
  return fetchUrl(url).then(text => {
    try {
      return JSON.parse(text);
    } catch (e) {
      console.error('fetchJson parse error:', e.message);
      return null;
    }
  });
}

function sanitizeFilename(value) {
  const base = String(value || 'document').replace(/\s+/g, ' ').trim();
  const cleaned = base.replace(/[<>:"/\\|?*]+/g, ' ').replace(/\s+/g, ' ').trim();
  const withoutExt = cleaned.replace(/\.pdf$/i, '');
  return `${withoutExt || 'document'}.pdf`;
}

function titleFromFilename(filename) {
   return normalizeTitleText(String(filename || 'Document').replace(/\.pdf$/i, '').replace(/\s*-\s*Kenya Law$/i, '')) || 'Document';
 }

 function cleanTitle(title) {
   return title
     .replace(/\s*\[\d{4}\]\s+[A-Z]{2,5}\s+\d+\s*\([A-Z]+\)\s*$/i, '')
     .replace(/\s*[-–|]\s*(Kenya Law Reports|KLR|KEHC|KECA|KESC|KEBL|KEPR|eLegal)\s*$/i, '')
     .replace(/\s+/g, ' ')
     .trim();
 }

function getLibrary() {
  return {
    precedents: [],
    statutes: [],
    total: 0
  };
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractKenyaLawDocumentInfo(html, fallbackUrl) {
  const fallbackTitle = normalizeTitleText((fallbackUrl || 'Document').split('/').pop() || 'Document');
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const metaTitleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  const h5Match = html.match(/<h5[^>]*class=["'][^"']*title[^"']*["'][^>]*>([\s\S]*?)<\/h5>/i);

  const rawTitle = (titleMatch && titleMatch[1]) || (metaTitleMatch && metaTitleMatch[1]) || (h5Match && h5Match[1]) || fallbackTitle;
  const title = decodeHtmlEntities(normalizeTitleText(rawTitle.replace(/\s+/g, ' '))).trim().replace(/\s*[-|]\s*Kenya Law$/i, '').trim() || fallbackTitle;

  const anchorMatch = html.match(/href=["']([^"']*\/source(?:\?[^"']*)?)["']/i);
  const sourceUrl = anchorMatch
    ? new URL(anchorMatch[1], fallbackUrl).toString()
    : null;

  return {
    title,
    label: title.replace(/^(The|An|A)\s+/i, '').trim() || title,
    citation: title,
    sourceUrl
  };
}

function normalizeTitleText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function toTitleCase(value) {
  const words = normalizeTitleText(value).toLowerCase().split(/\s+/).filter(Boolean);
  const stopWords = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);

  return words.map((word, index) => {
    const cleaned = word.replace(/[^a-z0-9]+/g, '');
    if (!cleaned) return '';
    if (index > 0 && stopWords.has(cleaned)) return cleaned;
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }).filter(Boolean).join(' ');
}

function extractDocumentMetadata(text, fallbackName) {
  const fallbackTitle = normalizeTitleText((fallbackName || 'Document').replace(/\.pdf$/i, '').replace(/\(\d+\)/g, '').trim()) || 'Document';
  const lines = (text || '').replace(/\r/g, '').split(/\n/).map(line => normalizeTitleText(line)).filter(Boolean);
  const candidates = [];

  for (const line of lines) {
    const trimmed = line.replace(/^[-*•\d.\s]+/, '').trim();
    if (!trimmed || trimmed.length < 4 || trimmed.length > 180) continue;
    if (/^(arrangement of sections|this act|part|section|subsection|schedule|chapter)/i.test(trimmed)) continue;
    if (/(act|law|regulation|regulations|rules?|constitution|code|ordinance|order|judgment|court|authority|amendment)/i.test(trimmed)) {
      candidates.push(trimmed);
    }
  }

  const titleLine = candidates[0] || fallbackTitle;
  const title = toTitleCase(titleLine) || fallbackTitle;
  const label = title.replace(/^(the|an|a)\s+/i, '').trim() || title;

  return {
    title,
    label,
    citation: title
  };
}

async function resolveKenyaLawDocument(url, fallbackTitle = 'Document') {
  if (!url || !/kenyalaw\.org/i.test(url)) {
    return null;
  }

  try {
    const html = await fetchUrl(url);
    const info = extractKenyaLawDocumentInfo(html, url);
    if (!info.sourceUrl) {
      return null;
    }

    const filename = sanitizeFilename(info.title || fallbackTitle);

    return {
      title: info.title || fallbackTitle,
      label: info.label || fallbackTitle,
      citation: info.citation || fallbackTitle,
      filename,
      readUrl: `/read/${encodeURIComponent(filename)}?title=${encodeURIComponent(info.title || fallbackTitle)}&sourceUrl=${encodeURIComponent(info.sourceUrl)}`,
      url,
      sourceUrl: info.sourceUrl,
      source: 'kenyalaw'
    };
  } catch (e) {
    console.error('resolveKenyaLawDocument error:', e.message);
    return null;
  }
}

function tokenize(text) {
  return text.toLowerCase().split(/\W+/).filter(w => w.length > 2);
}

function tokenizeQuery(query) {
  const tokens = query.toLowerCase().split(/\W+/).filter(w => w.length > 0);
  const shortTokens = tokens.filter(w => w.length <= 2);
  const longTokens = tokens.filter(w => w.length > 2);
  return { tokens, shortTokens, longTokens };
}

function buildSearchIndex() {
  if (fs.existsSync(INDEX_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
      if (data.statutes && data.statutes.length > 0) {
        console.log('Loaded search index from cache');
        return data;
      }
    } catch (e) {
      console.log('Index cache corrupted, rebuilding...');
    }
  }

  console.log('No local PDFs available, search index built from metadata only');
  const cacheData = { statutes: [], index: {}, builtAt: new Date().toISOString() };
  fs.writeFileSync(INDEX_FILE, JSON.stringify(cacheData));
  return cacheData;
}

function searchLocalIndex(query) {
  if (!searchIndex || !searchIndex.index) return [];

  const { tokens, shortTokens, longTokens } = tokenizeQuery(query);
  if (tokens.length === 0) return [];

  const scores = {};

  for (const term of longTokens) {
    const entries = searchIndex.index[term];
    if (!entries) continue;

    for (const entry of entries) {
      if (!scores[entry.file]) {
        scores[entry.file] = {
          title: entry.title,
          label: entry.label,
          citation: entry.citation,
          filename: entry.file,
          readUrl: entry.readUrl || `/read/${encodeURIComponent(entry.file)}`,
          score: 0,
          snippets: []
        };
      }
      scores[entry.file].score += entry.tf;
      if (scores[entry.file].snippets.length < 3) {
        scores[entry.file].snippets.push(entry.snippet);
      }
    }
  }

  for (const [file, entry] of Object.entries(scores)) {
    const titleWords = entry.title.toLowerCase().split(/\s+/);
    for (const short of shortTokens) {
      for (const word of titleWords) {
        if (word === short) {
          entry.score += 8;
          break;
        }
        if (word.length > 0 && word[0] === short) {
          entry.score += 4;
        }
      }
    }
  }

  return Object.values(scores)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .map(r => ({
      title: r.title,
      label: r.label,
      citation: r.citation,
      filename: r.filename,
      url: r.readUrl || `/read/${encodeURIComponent(r.filename)}`,
      readUrl: r.readUrl || `/read/${encodeURIComponent(r.filename)}`,
      source: 'local',
      score: r.score,
      snippets: r.snippets
    }));
}

function normalize(text) {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeKenyaLawSearchResults(payload) {
  const items = Array.isArray(payload && payload.results) ? payload.results : [];
  return items.map(item => {
    const title = normalizeTitleText(item.title || item.citation || item.expression_frbr_uri || 'Document');
    const citation = normalizeTitleText(item.citation || title);
    const url = item.expression_frbr_uri
      ? `https://kenyalaw.org${item.expression_frbr_uri}`
      : `https://kenyalaw.org/akn/ke/search`;

    return {
      title,
      label: citation.replace(/^(The|An|A)\s+/i, '').trim() || title,
      citation,
      url,
      source: 'kenyalaw',
      score: Number(item._score) || 0
    };
  });
}

function extractPDFLinks(html, baseUrl) {
  const pdfLinks = [];
  const seen = new Set();

  const pdfRegex = /href=["']([^"']+\.pdf(?:\?[^"']*)?)["']/gi;
  let match;
  while ((match = pdfRegex.exec(html)) !== null) {
    let pdfUrl = match[1];
    if (!pdfUrl.startsWith('http')) {
      pdfUrl = new URL(pdfUrl, baseUrl).toString();
    }
    const normalized = pdfUrl.toLowerCase();
    if (!seen.has(normalized) && normalized.endsWith('.pdf')) {
      seen.add(normalized);
      pdfLinks.push(pdfUrl);
    }
  }

  return pdfLinks;
}

function extractCitationFromText(text) {
  if (!text) return null;
  const cleaned = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const patterns = [
    /([A-Z][A-Za-z\s\.]+v\s+[A-Z][A-Za-z\s\.]+)\s*\((\d{4})\)/,
    /([A-Z][A-Za-z\s\.]+v\s+[A-Z][A-Za-z\s\.]+),?\s*\[(\d{4})\]/,
    /([A-Z][A-Za-z\s\.]+v\s+[A-Z][A-Za-z\s\.]+),?\s*(\d{4})\s*([A-Z]+)/,
    /(R\s+v\s+[A-Za-z\s\.]+),?\s*\((\d{4})\)/,
    /(People\s+v\s+[A-Za-z\s\.]+),?\s*\((\d{4})\)/,
    /(State\s+v\s+[A-Za-z\s\.]+),?\s*\((\d{4})\)/,
    /(United\s+States\s+v\s+[A-Za-z\s\.]+),?\s*\((\d{4})\)/
  ];
  for (const pattern of patterns) {
    const m = cleaned.match(pattern);
    if (m && m[1] && m[2]) {
      return `${m[1]} (${m[2]})`;
    }
  }
  const yearMatch = cleaned.match(/\((\d{4})\)/);
  if (yearMatch) {
    return cleaned.substring(0, 120);
  }
  return cleaned.substring(0, 120) || null;
}

let currentKeyIndex = 0;

function getAiClientObj() {
  const keysRaw = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '';
  const keys = keysRaw.split(',').map(k => k.trim()).filter(Boolean);
  if (keys.length === 0) return null;

  const keyIndex = currentKeyIndex % keys.length;
  const activeKey = keys[keyIndex];

  try {
    const ai = new GoogleGenAI({ apiKey: activeKey });
    return {
      ai,
      key: activeKey,
      keyCount: keys.length,
      rotateKey: () => {
        if (keys.length > 1) {
          currentKeyIndex = (currentKeyIndex + 1) % keys.length;
          console.warn(`[gemini] Quota/rate limit hit. Rotated to API Key #${currentKeyIndex + 1}/${keys.length}`);
        }
      }
    };
  } catch (e) {
    console.warn('[gemini] GoogleGenAI init error:', e.message);
    return null;
  }
}

function getAiClient() {
  const obj = getAiClientObj();
  return obj ? obj.ai : null;
}

/**
 * Machine Learning Jurisdiction & Intent Classifier
 * Uses Standalone Open-Source Native ML (Naive Bayes + TF-IDF Vectorizer)
 * No API key required, zero cost, no signup, zero quota limits.
 */
async function classifyQueryJurisdiction(query) {
  return classifyQueryOpenSourceML(query);
}

async function searchWithGeminiGrounding(query, source = 'all') {
  const ai = getAiClient();
  if (!ai) {
    console.warn('[gemini] GEMINI_API_KEY not set');
    return [];
  }

  const isInternational = source === 'international';
  const scopeText = source === 'kenya'
    ? 'Kenya Law reports, eKLR, Laws of Kenya, Constitution of Kenya, High Court & Court of Appeal judgments'
    : isInternational
    ? 'International legal databases: WorldLII, BAILII, Justia, Cornell LII, ICJ, ICC, ECHR, UN Treaties, WTO, IUS Mundi, and all major common law jurisdictions (UK, US, Canada, Australia, India, South Africa, etc.) – search for case law, statutes, treaties, and legal commentary. Prioritize official PDFs and court judgment documents.'
    : 'Kenya Law statutes/eKLR and global internet legal precedents across all international jurisdictions';

  const systemPrompt = `You are eLegal, an advanced legal research engine.
Conduct focused legal research for the query: "${query}".
Target Jurisdiction / Scope: ${scopeText}.

Search Strategy Instructions:
1. ${isInternational ? 'Since this is an out-of-Kenya international query, research broadly across the general internet legal resources (e.g. WorldLII, BAILII, Justia, Cornell Law, ICJ, UN Law, foreign courts, legal journals) apart from eKLR.' : source === 'kenya' ? 'Search Kenya Law (eKLR) and primary legal sources.' : 'Search both Kenya Law and international legal databases.'}
2. Prioritize direct PDF document links, official court judgment reports, legislation downloads, and legal papers.

Return a JSON array of up to 15 relevant results.
Format each item as a JSON object:
{
  "title": "Full Case or Statute Title (e.g. Donoghue v Stevenson [1932] AC 562 or Universal Declaration of Human Rights)",
  "label": "Short clean display title",
  "citation": "Official Citation or Reference (e.g., [1932] AC 562 or 217 A (III))",
  "url": "Direct web or PDF URL for the legal document",
  "source": "${source === 'kenya' ? 'kenyalaw' : 'international'}",
  "isPdf": true/false (true if link points to a PDF or official downloadable document),
  "snippets": ["Key ratio decidendi, statutory provision, or legal summary"]
}

Respond ONLY with a valid JSON array starting with '[' and ending with ']'. No markdown wrapper or extra text.`;

  const models = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'];

  for (const model of models) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: systemPrompt,
        config: {
          tools: [{ googleSearch: {} }],
          temperature: 0.2
        }
      });

      const results = [];
      let text = response.text || '';
      text = text.replace(/```json/gi, '').replace(/```/g, '').trim();

      const jsonMatch = text.match(/\[\s*\{[\s\S]*\}\s*\]/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          if (Array.isArray(parsed)) {
            for (const item of parsed) {
              if (!item.title) continue;
              const itemUrl = item.url || item.readUrl || 'https://worldlii.org';
              const isPdfUrl = itemUrl.endsWith('.pdf') || itemUrl.includes('.pdf?') || Boolean(item.isPdf);
              results.push({
                title: item.title,
                label: item.label || item.title.replace(/^(The|An|A)\s+/i, '').trim(),
                citation: item.citation || item.title,
                url: itemUrl,
                readUrl: itemUrl,
                source: item.source || (itemUrl.includes('kenyalaw.org') ? 'kenyalaw' : 'international'),
                isPdf: isPdfUrl,
                fileType: isPdfUrl ? 'PDF' : 'DOC',
                score: isPdfUrl ? 98 : 90,
                snippets: Array.isArray(item.snippets) ? item.snippets : [item.snippets || '']
              });
            }
          }
        } catch (e) {
          console.warn('[gemini] Failed to parse JSON response:', e.message);
        }
      }

      const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks;
      if (chunks && Array.isArray(chunks)) {
        const existingUrls = new Set(results.map(r => r.url));
        for (const chunk of chunks) {
          if (chunk.web && chunk.web.uri && !existingUrls.has(chunk.web.uri)) {
            existingUrls.add(chunk.web.uri);
            const isPdfUrl = chunk.web.uri.endsWith('.pdf') || chunk.web.uri.includes('.pdf?');
            results.push({
              title: chunk.web.title || 'Legal Resource',
              label: chunk.web.title || 'Legal Resource',
              citation: chunk.web.title || '',
              url: chunk.web.uri,
              readUrl: chunk.web.uri,
              source: chunk.web.uri.includes('kenyalaw.org') ? 'kenyalaw' : 'international',
              isPdf: isPdfUrl,
              fileType: isPdfUrl ? 'PDF' : 'WEB',
              score: isPdfUrl ? 95 : 85,
              snippets: [`Direct web research: ${chunk.web.title}`]
            });
          }
        }
      }

      if (results.length > 0) {
        return results;
      }
    } catch (err) {
      const isQuota = err.message && (err.message.includes('429') || err.message.includes('RESOURCE_EXHAUSTED') || err.message.includes('quota'));
      if (isQuota) {
        console.warn(`[gemini] Quota limit hit on ${model}. Attempting key rotation...`);
        const obj = getAiClientObj();
        if (obj) obj.rotateKey();
        break;
      }
      console.warn(`[gemini] Model ${model} search grounding error:`, err.message);
    }
  }

  return [];
}

async function searchFastWeb(query, source = 'all') {
  // Build a rich query that covers both Kenya and international legal databases
  const isIntl = source === 'international';
  const isKenya = source === 'kenya';
  
  const sites = isIntl
    ? ['worldlii.org', 'bailii.org', 'justia.com', 'law.cornell.edu', 'icj-cij.org', 'icc-cpi.int', 'echr.coe.int', 'un.org/en/law', 'treaties.un.org', 'legal.un.org', 'iusmundi.com']
    : isKenya
    ? ['kenyalaw.org']
    : ['kenyalaw.org', 'worldlii.org', 'bailii.org', 'justia.com', 'law.cornell.edu', 'icj-cij.org', 'icc-cpi.int', 'echr.coe.int', 'un.org/en/law', 'treaties.un.org'];

  const siteQuery = `(${sites.map(s => `site:${s}`).join(' OR ')})`;
  const scopeQuery = `${query} ${siteQuery} filetype:pdf OR case law OR judgment OR statute OR treaty OR ruling`;

  try {
    const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(scopeQuery)}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });
    if (!response.ok) return [];
    const html = await response.text();
    const results = [];
    const seen = new Set();
    const regex = /<a[^>]+href="([^"]*uddg=([^"&]+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = regex.exec(html)) !== null) {
      const encodedUrl = m[2];
      const rawText = m[3].replace(/<[^>]+>/g, '').trim();
      if (!rawText || rawText.length < 3 || rawText.includes('http://') || rawText.includes('https://') || rawText.startsWith('//')) continue;

      let actualUrl = decodeURIComponent(encodedUrl);
      if (!actualUrl || actualUrl.includes('duckduckgo.com')) continue;
      
      const key = actualUrl.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const title = rawText.replace(/^\|\s*/, '').trim();
      const isKenyaUrl = actualUrl.includes('kenyalaw.org');
      const isPdfUrl = actualUrl.endsWith('.pdf') || actualUrl.includes('.pdf?') || title.toLowerCase().includes('[pdf]');

      results.push({
        title,
        label: title.replace(/^(The|An|A)\s+/i, '').trim(),
        citation: title,
        url: actualUrl,
        readUrl: actualUrl,
        source: isKenyaUrl ? 'kenyalaw' : 'international',
        isPdf: isPdfUrl,
        fileType: isPdfUrl ? 'PDF' : 'DOC',
        score: isPdfUrl ? 90 : 80,
        snippets: [actualUrl]
      });
      if (results.length >= 25) break;
    }
    return results;
  } catch (e) {
    console.error('Fast web fallback search error:', e.message);
    return [];
  }
}

async function fetchKenyaLawDirect(query) {
  const searchUrl = `https://kenyalaw.org/search/api/documents/?search=${encodeURIComponent(query)}&page=1&ordering=-score`;
  try {
    const text = await fetchUrl(searchUrl);
    const payload = JSON.parse(text);
    return normalizeKenyaLawSearchResults(payload);
  } catch (e) {
    return [];
  }
}

function extractLinks(text) {
  const results = [];
  const seen = new Set();
  const urlMap = new Map();

  const markdownRegex = /\[([^\]]+)\]\((https?:\/\/kenyalaw\.org\/akn\/ke\/[^)#]+)\)/gi;
  let mdMatch;

  while ((mdMatch = markdownRegex.exec(text)) !== null) {
    let title = mdMatch[1].trim();
    let url = mdMatch[2];
    url = url.replace(/^http:\/\//, 'https://').replace(/\/eng@.*$/, '/eng');
    if (!url.endsWith('/eng')) url += '/eng';

    if (url.includes('#')) continue;

    if (title.includes('[') || title.includes(']') || title.includes('*') || title.includes('#')) {
      const pathParts = url.replace(/https?:\/\/kenyalaw\.org\/akn\/ke\//, '').split('/');
      if (pathParts.length >= 3) {
        const type = pathParts[0];
        const year = pathParts[1];
        const number = pathParts[2];
        title = type === 'act' ? `Act ${year}/${number}` : type === 'judgment' ? `Judgment ${year}/${number}` : type === 'bill' ? `Bill ${year}/${number}` : url.split('/').pop() || 'Document';
      } else {
        title = url.split('/').pop() || 'Document';
      }
    }

    if (!urlMap.has(url)) {
      urlMap.set(url, { url, title });
    }
  }

  const urlRegex = /(?:https?:\/\/kenyalaw\.org)?\/akn\/ke\/[^\s)"'>]+/gi;
  let urlMatch;

  while ((urlMatch = urlRegex.exec(text)) !== null) {
    let url = urlMatch[0];
    if (!url.startsWith('http')) {
      url = 'https://kenyalaw.org' + url;
    }
    let normalizedUrl = url.replace(/^http:\/\//, 'https://').replace(/\/eng@.*$/, '/eng');
    if (!normalizedUrl.endsWith('/eng')) normalizedUrl += '/eng';

    if (normalizedUrl.includes('#')) continue;
    if (urlMap.has(normalizedUrl)) continue;
    urlMap.set(normalizedUrl, { url: normalizedUrl, title: null });
  }

  for (const [url, data] of urlMap) {
    let title = data.title;
    if (!title) {
      const pathParts = url.replace(/https?:\/\/kenyalaw\.org\/akn\/ke\//, '').split('/');
      if (pathParts.length >= 3) {
        const type = pathParts[0];
        const year = pathParts[1];
        const number = pathParts[2];
        title = type === 'act' ? `Act ${year}/${number}` : type === 'judgment' ? `Judgment ${year}/${number}` : type === 'bill' ? `Bill ${year}/${number}` : url.split('/').pop() || 'Document';
      } else {
        title = url.split('/').pop() || 'Document';
      }
    }

    title = title.replace(/\s+/g, ' ').trim();
    if (!title || title.length < 3 || title.length > 200) continue;

    const normalizedTitle = normalize(title);
    if (seen.has(normalizedTitle)) continue;

    seen.add(normalizedTitle);
    const label = title.replace(/^(The|An|A)\s+/i, '').trim() || title;
    results.push({ title, label, citation: title, url, source: 'kenyalaw' });
  }

  return results.slice(0, 30);
}

function rankResults(results, query, classification = null) {
  const stopWords = new Set(['v', 'vs', 'r', 're', 'the', 'and', 'or', 'in', 'of', 'to', 'at', 'a', 'an', 'for']);
  const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 1 && !stopWords.has(t));

  return results.map(r => {
    const titleLower = (r.title || '').toLowerCase();
    const citationLower = (r.citation || '').toLowerCase();
    const urlLower = (r.url || r.readUrl || '').toLowerCase();
    let score = r.score || 50;

    // Prioritize PDF and official document results
    const isPdf = Boolean(r.isPdf) || urlLower.endsWith('.pdf') || urlLower.includes('.pdf?') || titleLower.includes('pdf');
    const isDoc = isPdf || urlLower.includes('/doc/') || urlLower.includes('/document/') || urlLower.includes('/cases/') || urlLower.includes('/akn/ke/') || urlLower.includes('kenyalaw.org') || urlLower.includes('bailii.org') || urlLower.includes('worldlii.org') || urlLower.includes('justia.com') || urlLower.includes('law.cornell.edu');

    r.isPdf = isPdf;
    r.isDocument = isDoc;
    r.fileType = isPdf ? 'PDF' : (isDoc ? 'DOC' : 'WEB');

    if (isPdf) {
      score += 45; // Significant priority boost for PDF files
    } else if (isDoc) {
      score += 25; // Priority boost for formal legal documents
    }

    // Boost for query term matches (neutral, no Kenya bias)
    let allMatch = true;
    for (const term of queryTerms) {
      if (titleLower.includes(term) || citationLower.includes(term)) {
        score += 15;
        if (titleLower.startsWith(term)) score += 10;
      } else {
        allMatch = false;
      }
    }

    if (allMatch && queryTerms.length > 0) {
      score += 30;
    }

    // Classification alignment boost (neutral, no Kenya bias)
    if (classification) {
      if (classification.jurisdiction === 'international' && r.source === 'international') {
        score += 20;
      } else if (classification.jurisdiction === 'kenya' && (r.source === 'kenyalaw' || r.source === 'local')) {
        score += 20;
      }
    }

    return { ...r, score };
  }).sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return (a.title || '').localeCompare(b.title || '');
  });
}

async function searchWithRetry(query, retries = 1, source = 'all', classification = null) {
  const normalizedQuery = query.trim().replace(/\s+/g, ' ');
  if (!normalizedQuery) return [];

  // Determine effective source: use user override or ML classification
  const effectiveSource = (classification && ['kenya', 'international'].includes(classification.jurisdiction)) 
    ? classification.jurisdiction 
    : source;

  const stopWords = new Set(['v', 'vs', 'r', 're', 'the', 'and', 'or', 'in', 'of', 'to', 'at', 'a', 'an', 'for']);
  const sigTokens = normalizedQuery.toLowerCase().split(/\W+/).filter(t => t.length > 1 && !stopWords.has(t));

  // 1. Always run web search (DuckDuckGo) – the PRIMARY engine
  const webPromise = searchFastWeb(normalizedQuery, effectiveSource);

  // 2. Always run Gemini (AI grounded search) – covers both Kenya & international
  const geminiPromise = searchWithGeminiGrounding(normalizedQuery, effectiveSource);

  // 3. Kenya Law API – only if the source suggests Kenya or we are in 'all' mode (optional extra)
  const kenyaPromise = (effectiveSource === 'all' || effectiveSource === 'kenya')
    ? fetchKenyaLawDirect(normalizedQuery)
    : Promise.resolve([]);

  const timeoutPromise = new Promise(resolve => setTimeout(() => resolve([]), 10000));

  // Run all searches in parallel with a timeout
  const [webResults, geminiResults, kenyaResults] = await Promise.all([
    Promise.race([webPromise, timeoutPromise]),
    Promise.race([geminiPromise, timeoutPromise]),
    Promise.race([kenyaPromise, timeoutPromise])
  ]);

  // Merge all results, de‑duplicate by URL
  const combined = [];
  const seen = new Set();
  const allResults = [...webResults, ...geminiResults, ...kenyaResults];

  // Also check local repository docs
  const repoDocs = getRepositoryDocs();
  const repoMatches = repoDocs.filter(doc => {
    const target = `${doc.title || ''} ${doc.citation || ''} ${doc.type || ''} ${doc.source || ''} ${doc.year || ''}`.toLowerCase();
    if (sigTokens.length > 0) {
      return sigTokens.some(t => target.includes(t));
    }
    return false;
  }).map(d => ({ ...d, score: 60, source: 'local' }));

  // Combine all results
  const allSources = [...allResults, ...repoMatches];

  for (const item of allSources) {
    const key = (item.url || item.title || '').toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      const enriched = enrichDocumentMetadata(item);
      combined.push(enriched);
      // Save to local repository for future caching
      saveDocToRepository(enriched);
    }
  }

  // If we got nothing, fallback to all repository docs
  if (combined.length === 0) {
    for (const doc of repoDocs) {
      const key = (doc.url || doc.title || '').toLowerCase();
      if (key && !seen.has(key)) {
        seen.add(key);
        combined.push(doc);
      }
    }
  }

  // Rank results: PDFs and relevant documents get boosted (no Kenya bias)
  return rankResults(combined, normalizedQuery, classification).slice(0, 30);
}

async function fetchLatestKenyaLawItems() {
  try {
    const latestItems = await searchFastWeb('site:kenyalaw.org 2026 OR 2025 judgment OR act OR ruling', 'kenya');
    const savedItems = [];
    for (const item of latestItems) {
      const enriched = enrichDocumentMetadata({ ...item, year: item.year || '2025' });
      savedItems.push(saveDocToRepository(enriched));
    }
    return savedItems;
  } catch (err) {
    console.warn('fetchLatestKenyaLawItems warning:', err.message);
    return [];
  }
}

app.get('/api/latest-kenyalaw', async (req, res) => {
  try {
    const latest = await fetchLatestKenyaLawItems();
    const repoDocs = getRepositoryDocs();
    res.json({ latest, docs: repoDocs, total: repoDocs.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


app.get('/api/docs', (req, res) => {
  res.json({
    name: 'eLegal API',
    version: '1.0.0',
    description: 'Search Kenya Law statutes and judgments with AI-powered ranking.',
    baseUrl: '/api',
    authentication: {
      type: 'API Key',
      header: 'X-API-Key',
      description: 'Include your API key in the X-API-Key header of every request.'
    },
    endpoints: [
      {
        path: '/api/search?q=<query>',
        method: 'GET',
        description: 'Search local statutes and Kenya Law records.',
        parameters: [
          { name: 'q', type: 'string', required: true, description: 'Search query' }
        ],
        response: { query: 'string', results: 'array', total: 'number' }
      },
      {
        path: '/api/library',
        method: 'GET',
        description: 'Get the local document library (precedents and statutes).',
        response: { precedents: 'array', statutes: 'array', total: 'number' }
      },
      {
        path: '/api/resolve?url=<url>&title=<title>',
        method: 'GET',
        description: 'Resolve a Kenya Law record URL to a downloadable PDF.',
        parameters: [
          { name: 'url', type: 'string', required: true, description: 'Kenya Law record URL (must be kenyalaw.org)' },
          { name: 'title', type: 'string', required: false, description: 'Document title' }
        ],
        response: { title: 'string', label: 'string', citation: 'string', readUrl: 'string', url: 'string', filename: 'string' }
      },
      {
        path: '/api/health',
        method: 'GET',
        description: 'Check API health status.',
        response: { status: 'string' }
       },
       {
         path: '/api/auth/verify',
         method: 'POST',
         description: 'Verify a Firebase ID token and return user info.',
         headers: { 'Authorization': 'Firebase ID token (required)' },
         response: { uid: 'string', email: 'string', displayName: 'string' }
       },
       {
         path: '/api/keys',
         method: 'POST',
         description: 'Generate a new API key. Requires Firebase authentication.',
         headers: { 'Authorization': 'Firebase ID token (required)' },
         body: { label: 'string (optional)' },
         response: { key: 'string', label: 'string', createdAt: 'string' }
       },
       {
         path: '/api/keys',
         method: 'GET',
         description: 'List your API keys. Requires Firebase authentication.',
         headers: { 'Authorization': 'Firebase ID token (required)' },
         response: 'array of key objects'
       }
    ],
    examples: {
      curl: `curl -H "X-API-Key: el_your_key_here" "http://localhost:3000/api/search?q=land+act"`,
      javascript: `const res = await fetch('http://localhost:3000/api/search?q=land+act', {\n  headers: { 'X-API-Key': 'el_your_key_here' }\n});\nconst data = await res.json();`,
      python: `import requests\nres = requests.get('http://localhost:3000/api/search?q=land+act',\n  headers={'X-API-Key': 'el_your_key_here'})\ndata = res.json()`
    }
  });
});

app.post('/api/auth/verify', async (req, res) => {
  const idToken = req.headers['authorization'];
  if (!idToken) {
    console.warn('[auth] verify: missing authorization header');
    return res.status(401).json({ error: 'ID token required', code: 'MISSING_TOKEN' });
  }
  try {
    if (!admin.getApps().length) {
      console.error('[auth] verify: Firebase Admin SDK not initialized');
      return res.status(503).json({ error: 'Auth service unavailable', code: 'SERVICE_UNAVAILABLE' });
    }
    const decoded = await getAuth(admin.getApp()).verifyIdToken(idToken);
    const user = await getAuth(admin.getApp()).getUser(decoded.uid);
    console.log('[auth] verify: token verified for', decoded.uid, user.email);
    res.json({ uid: decoded.uid, email: user.email, displayName: user.displayName, photoURL: user.photoURL });
  } catch (e) {
    console.error('[auth] verify: token verification failed:', e.code, e.message);
    res.status(401).json({ error: 'Invalid token', code: 'INVALID_TOKEN' });
  }
});

app.post('/api/keys', async (req, res) => {
   const idToken = req.headers['authorization'];
   if (!idToken) {
     console.warn('[auth] create key: missing authorization header');
     return res.status(401).json({ error: 'Firebase ID token required', code: 'MISSING_TOKEN' });
   }
   try {
     const decoded = await getAuth(admin.getApp()).verifyIdToken(idToken);
     console.log('[auth] create key: token verified for', decoded.uid);
     const label = (req.body && req.body.label) || 'default';
     const key = await createApiKey(label, decoded.uid);
     res.status(201).json(key);
   } catch (e) {
     console.error('[auth] create key: error:', e.code, e.message);
     if (e.code === 'auth/id-token-expired' || e.code === 'auth/argument-error' || e.message && e.message.includes('Invalid Firebase token')) {
       res.status(401).json({ error: 'Invalid Firebase token', code: 'INVALID_TOKEN' });
     } else if (e.message && e.message.includes('Firestore not configured')) {
       res.status(503).json({ error: e.message, code: 'FIRESTORE_UNAVAILABLE' });
     } else if (e.code === 16 || e.code === 'UNAUTHENTICATED' || (e.message && e.message.includes('UNAUTHENTICATED'))) {
       res.status(503).json({ error: 'Firebase credentials lack Firestore permissions — ensure the service account has Cloud Firestore Editor role', code: 'FIREBASE_UNAVAILABLE' });
     } else {
       res.status(500).json({ error: e.message || 'Failed to create API key', code: 'KEY_CREATION_FAILED' });
     }
   }
 });

async function getUserIdFromReq(req) {
  const idToken = req.headers['authorization'];
  if (!idToken) return null;
  const token = idToken.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  try {
    if (admin.getApps().length > 0) {
      const decoded = await getAuth(admin.getApp()).verifyIdToken(token);
      return decoded.uid;
    }
  } catch (_) {}
  // Sanitize token string for fallback local user id
  return 'user_' + crypto.createHash('md5').update(token).digest('hex').substring(0, 16);
}

app.get('/api/keys', async (req, res) => {
  const idToken = req.headers['authorization'];
  if (!idToken) {
    return res.status(401).json({ error: 'Firebase ID token required', code: 'MISSING_TOKEN' });
  }
  try {
    const userId = await getUserIdFromReq(req);
    const keys = [];
    let fetchedFromFirestore = false;

    try {
      const db = getFirestore();
      if (db) {
        const userDoc = await db.collection('apikeys').doc(userId).get();
        if (userDoc.exists) {
          const snapshot = await userDoc.ref.collection('keys').get();
          snapshot.forEach(doc => {
            const data = doc.data();
            keys.push({ key: doc.id, label: data.label, createdAt: data.createdAt, lastUsed: data.lastUsed, requestCount: data.requestCount, isActive: data.isActive, replacedAt: data.replacedAt });
          });
        }
        fetchedFromFirestore = true;
      }
    } catch (dbErr) {
      // Firestore error, fall through to local store
    }

    if (!fetchedFromFirestore) {
      const userKeys = getLocalKeys();
      const uKeys = userKeys[userId] || {};
      Object.entries(uKeys).forEach(([kId, data]) => {
        keys.push({ key: kId, label: data.label, createdAt: data.createdAt, lastUsed: data.lastUsed, requestCount: data.requestCount, isActive: data.isActive, replacedAt: data.replacedAt });
      });
    }

    res.json(keys);
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to list keys', code: 'KEY_FETCH_FAILED' });
  }
});

app.get('/api/keys/current', async (req, res) => {
  const idToken = req.headers['authorization'];
  if (!idToken) {
    return res.status(401).json({ error: 'Firebase ID token required', code: 'MISSING_TOKEN' });
  }
  try {
    const userId = await getUserIdFromReq(req);
    const keys = [];
    let fetchedFromFirestore = false;

    try {
      const db = getFirestore();
      if (db) {
        const userDoc = await db.collection('apikeys').doc(userId).get();
        if (userDoc.exists) {
          const snapshot = await userDoc.ref.collection('keys').get();
          snapshot.forEach(doc => {
            const data = doc.data();
            keys.push({ key: doc.id, label: data.label, createdAt: data.createdAt, lastUsed: data.lastUsed, requestCount: data.requestCount, isActive: data.isActive, replacedAt: data.replacedAt });
          });
        }
        fetchedFromFirestore = true;
      }
    } catch (dbErr) {
      // Firestore error, fall through to local store
    }

    if (!fetchedFromFirestore) {
      const userKeys = getLocalKeys();
      const uKeys = userKeys[userId] || {};
      Object.entries(uKeys).forEach(([kId, data]) => {
        keys.push({ key: kId, label: data.label, createdAt: data.createdAt, lastUsed: data.lastUsed, requestCount: data.requestCount, isActive: data.isActive, replacedAt: data.replacedAt });
      });
    }

    res.json(keys);
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to fetch current keys', code: 'KEY_FETCH_FAILED' });
  }
});

app.patch('/api/keys/:keyId', async (req, res) => {
  const idToken = req.headers['authorization'];
  if (!idToken) {
    return res.status(401).json({ error: 'Firebase ID token required', code: 'MISSING_TOKEN' });
  }
  try {
    const userId = await getUserIdFromReq(req);
    const keyId = req.params.keyId;

    let updatedData = null;

    try {
      const db = getFirestore();
      if (db) {
        const keyRef = db.collection('apikeys').doc(userId).collection('keys').doc(keyId);
        const doc = await keyRef.get();
        if (doc.exists) {
          const updates = {};
          if (req.body && typeof req.body.isActive !== 'undefined') updates.isActive = req.body.isActive;
          if (req.body && req.body.label) updates.label = req.body.label;
          if (Object.keys(updates).length > 0) {
            await keyRef.update(updates);
            const updatedDoc = await keyRef.get();
            updatedData = { key: updatedDoc.id, ...updatedDoc.data() };
          }
        }
      }
    } catch (e) {
      // Firestore unavailable
    }

    const userKeys = getLocalKeys();
    if (userKeys[userId] && userKeys[userId][keyId]) {
      if (req.body && typeof req.body.isActive !== 'undefined') userKeys[userId][keyId].isActive = req.body.isActive;
      if (req.body && req.body.label) userKeys[userId][keyId].label = req.body.label;
      saveLocalKeys(userKeys);
      if (!updatedData) {
        updatedData = { key: keyId, ...userKeys[userId][keyId] };
      }
    }

    if (!updatedData) {
      return res.status(404).json({ error: 'Key not found', code: 'KEY_NOT_FOUND' });
    }

    res.json(updatedData);
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to update key', code: 'KEY_UPDATE_FAILED' });
  }
});

app.delete('/api/keys/:keyId', async (req, res) => {
  const idToken = req.headers['authorization'];
  if (!idToken) {
    return res.status(401).json({ error: 'Firebase ID token required', code: 'MISSING_TOKEN' });
  }
  try {
    const userId = await getUserIdFromReq(req);
    const keyId = req.params.keyId;

    try {
      const db = getFirestore();
      if (db) {
        const keyRef = db.collection('apikeys').doc(userId).collection('keys').doc(keyId);
        await keyRef.delete();
      }
    } catch (e) {
      // Firestore unavailable
    }

    const userKeys = getLocalKeys();
    if (userKeys[userId] && userKeys[userId][keyId]) {
      delete userKeys[userId][keyId];
      saveLocalKeys(userKeys);
    }

    rateLimits.delete(keyId);
    res.json({ key: keyId, deleted: true });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to delete key', code: 'KEY_DELETE_FAILED' });
  }
});

app.get('/api/search', async (req, res) => {
  const q = req.query.q || '';
  const sourceOverride = req.query.source || 'all'; // 'all', 'kenya', 'international'
  if (!q.trim()) {
    return res.json({ query: q, results: [], total: 0 });
  }

  if (!['all', 'kenya', 'international'].includes(sourceOverride)) {
    return res.status(400).json({ error: 'Invalid source parameter. Use all, kenya, or international.' });
  }

  try {
    // 1. Machine Learning Jurisdiction & Legal Domain Classifier
    const classification = await classifyQueryJurisdiction(q);

    // Respect explicit user source override if provided, else use ML classified jurisdiction
    const effectiveSource = sourceOverride !== 'all' ? sourceOverride : classification.jurisdiction;

    // 2. Execute targeted legal research (eKLR for Kenya, General Internet for International) & PDF prioritization
    const rawResults = await searchWithRetry(q, 2, effectiveSource, classification);
    const limit = req.query.limit ? Math.min(parseInt(req.query.limit) || 5, 20) : 5;
    const results = (rawResults || []).slice(0, limit);

    res.json({
      query: q,
      source: effectiveSource,
      classification,
      results,
      total: results.length
    });
  } catch (e) {
    console.error('Search error:', e);
    res.status(500).json({ error: 'Search failed', message: e.message || 'Unknown error' });
  }
});

app.get('/api/library', (req, res) => {
  try {
    const docs = getRepositoryDocs();
    const precedents = docs.filter(d => d.type === 'Judgment' || d.type === 'Precedent' || d.type === 'Ruling' || d.type === 'Advisory Opinion');
    const statutes = docs.filter(d => d.type === 'Constitution' || d.type === 'Legislation' || d.type === 'Bill' || d.type === 'Gazette Notice');

    res.json({
      precedents,
      statutes,
      docs,
      total: docs.length
    });
  } catch (e) {
    console.error('Library error:', e);
    res.status(500).json({ error: 'Library failed', message: e.message || 'Unknown error' });
  }
});

app.get('/api/resolve', validateApiKey, async (req, res) => {
  const url = req.query.url || '';
  const title = req.query.title || 'Document';

  if (!/^https?:\/\/(?:www\.)?kenyalaw\.org/i.test(url)) {
    return res.status(400).json({ error: 'Only Kenya Law document URLs can be resolved' });
  }

  try {
    const documentInfo = await resolveKenyaLawDocument(url, title);
    if (!documentInfo || !documentInfo.readUrl) {
      return res.status(404).json({ error: 'PDF source not found for this Kenya Law record' });
    }

    res.json(documentInfo);
  } catch (e) {
    console.error('Resolve error:', e);
    res.status(500).json({ error: 'Resolve failed', message: e.message || 'Unknown error' });
  }
});

const bulletinImageCache = new Map();

/**
 * Dynamically resolves an authentic, non-AI image URL for a legal bulletin or keyword.
 * 1. Tries direct page scraping if bulletin has a source URL.
 * 2. Dynamically crawls / searches Wikimedia Commons & Wikipedia using bulletin content keywords
 *    (e.g., "Kenya Court of Appeal", "Supreme Court of Kenya", "Nairobi Law Courts building").
 * 3. Falls back strictly to authentic photographic landmark images of Kenyan courts/emblems.
 * Removes AI and generic stock photos completely.
 */
async function fetchActualImageForBulletin(bulletin = {}) {
  if (!bulletin) return 'https://upload.wikimedia.org/wikipedia/commons/0/07/Nairobi_Law_Courts.jpg';

  const cacheKey = bulletin.id || (bulletin.title ? bulletin.title.toLowerCase().trim() : null);
  if (cacheKey && bulletinImageCache.has(cacheKey)) {
    return bulletinImageCache.get(cacheKey);
  }

  let resolvedUrl = null;

  // 1. Direct fetch & scrape attempt if bulletin has source URL
  const targetUrl = bulletin.url || bulletin.sourceUrl;
  if (targetUrl && /^https?:\/\//i.test(targetUrl)) {
    try {
      const html = await fetchUrl(targetUrl);
      if (html) {
        const ogMatch = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i) ||
                        html.match(/<meta\s+content=["']([^"']+)["']\s+property=["']og:image["']/i) ||
                        html.match(/<meta\s+name=["']twitter:image["']\s+content=["']([^"']+)["']/i) ||
                        html.match(/<link\s+rel=["']image_src["']\s+href=["']([^"']+)["']/i);

        if (ogMatch && ogMatch[1] && /^https?:\/\//i.test(ogMatch[1]) && !ogMatch[1].includes('unsplash')) {
          resolvedUrl = ogMatch[1];
        }
      }
    } catch (err) {
      console.warn(`[bulletin-image] Direct scrape note for ${targetUrl}:`, err.message);
    }
  }

  // 2. Dynamic crawling based on content & extracted keywords
  if (!resolvedUrl) {
    const fullText = `${bulletin.title || ''} ${bulletin.summary || ''} ${(bulletin.tags || []).join(' ')} ${bulletin.source || ''}`.trim();

    // Construct targeted search terms based on bulletin content
    let searchTerms = [];

    if (/supreme court/i.test(fullText)) {
      searchTerms.push('Supreme Court of Kenya', 'Supreme Court building Nairobi');
    } else if (/court of appeal/i.test(fullText)) {
      searchTerms.push('Kenya Court of Appeal', 'Nairobi Law Courts');
    } else if (/mombasa/i.test(fullText)) {
      searchTerms.push('Old Law Courts Mombasa', 'Mombasa Law Courts');
    } else if (/parliament|bill|legislation|assembly/i.test(fullText)) {
      searchTerms.push('Parliament Buildings Nairobi', 'Parliament of Kenya');
    } else if (/chief justice|koome|mwilu/i.test(fullText)) {
      searchTerms.push('Chief Justice Martha Koome', 'Supreme Court of Kenya');
    } else if (/land|nlc|gazette|title|boundary/i.test(fullText)) {
      searchTerms.push('Coat of arms of Kenya', 'Nairobi Law Courts');
    } else {
      searchTerms.push('Kenya High Court', 'Nairobi Law Courts');
    }

    // Try Wikimedia Commons API search with User-Agent header and 3s timeout
    for (const queryTerm of searchTerms) {
      try {
        const wikiUrl = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(queryTerm)}&gsrnamespace=6&prop=imageinfo&iiprop=url&format=json`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);

        const res = await fetch(wikiUrl, {
          headers: { 'User-Agent': 'eLegalResearchBot/1.0 (info@elegal.co.ke)' },
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (res.ok) {
          const data = await res.json();
          if (data && data.query && data.query.pages) {
            const pages = Object.values(data.query.pages);
            const found = pages.map(p => p.imageinfo?.[0]?.url).find(u => u && /^https?:\/\//i.test(u) && !u.includes('unsplash') && /\.(jpg|jpeg|png|svg|webp)(\?.*)?$/i.test(u));
            if (found) {
              resolvedUrl = found;
              break;
            }
          }
        }
      } catch (err) {
        // Fall through to next term or landmark fallback
      }
    }
  }

  // 3. Fallback to authentic real-world court building landmarks & official emblem (NO AI, NO UNSPLASH)
  if (!resolvedUrl) {
    const text = `${bulletin.title || ''} ${bulletin.summary || ''}`.toLowerCase();
    if (text.includes('supreme court')) {
      resolvedUrl = 'https://upload.wikimedia.org/wikipedia/commons/0/0a/Supreme_Court_of_Kenya.JPG';
    } else if (text.includes('parliament') || text.includes('bill') || text.includes('legislation')) {
      resolvedUrl = 'https://upload.wikimedia.org/wikipedia/commons/b/bd/Parliament_Buildings%2C_Nairobi%2C_Kenya_-entrance-15April2010.jpg';
    } else if (text.includes('chief justice') || text.includes('koome')) {
      resolvedUrl = 'https://upload.wikimedia.org/wikipedia/commons/0/0f/Chief_Justice_Martha_K._Koome_and_Deputy_Chief_Justice_Philomena_Mwilu.jpg';
    } else if (text.includes('mombasa')) {
      resolvedUrl = 'https://upload.wikimedia.org/wikipedia/commons/6/61/Old_law_courst_mombasa.JPG';
    } else if (text.includes('land') || text.includes('gazette') || text.includes('title')) {
      resolvedUrl = 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/49/Coat_of_arms_of_Kenya_%28Heraldry%29.svg/800px-Coat_of_arms_of_Kenya_%28Heraldry%29.svg.png';
    } else {
      resolvedUrl = 'https://upload.wikimedia.org/wikipedia/commons/0/07/Nairobi_Law_Courts.jpg';
    }
  }

  if (cacheKey) {
    bulletinImageCache.set(cacheKey, resolvedUrl);
  }

  return resolvedUrl;
}

app.get('/api/resolve-image', async (req, res) => {
  const keyword = (req.query.keyword || req.query.query || 'Kenya Court of Appeal').trim();
  try {
    const fakeBulletin = { title: keyword, summary: keyword };
    const imageUrl = await fetchActualImageForBulletin(fakeBulletin);
    res.json({ keyword, imageUrl, source: 'Wikimedia / Official Law Archives' });
  } catch (e) {
    res.json({
      keyword,
      imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/0/07/Nairobi_Law_Courts.jpg',
      source: 'Nairobi Law Courts Official Landmark'
    });
  }
});

app.get('/api/bulletins', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.max(1, parseInt(req.query.limit || '6', 10));
    const category = req.query.category || 'all';

    const bulletins = [
      {
        id: 'bulletin-001',
        title: 'High Court Practice Direction 2026: Mandatory Electronic Filing & Virtual Case Management',
        category: 'judiciary',
        categoryLabel: 'Judiciary Bulletin',
        date: '2026-08-10',
        summary: 'Chief Justice issues updated directives requiring all civil, commercial, and judicial review pleadings to be submitted through the integrated e-Filing system with automated hearing scheduling.',
        readTime: '3 min read',
        source: 'Judiciary of Kenya',
        impact: 'High',
        tags: ['e-Filing', 'Civil Procedure', 'High Court'],
        content: 'The Honorable Chief Justice has issued Practice Direction No. 2 of 2026 regarding e-Filing and virtual court proceedings across all High Court stations. Under the new directive, paper filings are strictly phased out for represented litigants. Key mandates include automated service verification, standardized digital pdf bundle indexing, and 48-hour prior filing requirements for skeleton arguments.'
      },
      {
        id: 'bulletin-002',
        title: 'Kenya Gazette Special Issue: National Land Commission Title Review & Advisory Guidelines',
        category: 'gazette',
        categoryLabel: 'Gazette Notice',
        date: '2026-08-08',
        summary: 'Special Gazette Notice detailing new procedural rules for reviewing historical land allocation titles, boundary rectification, and adverse possession claims.',
        readTime: '4 min read',
        source: 'Kenya Gazette Vol. CXXVIII No. 42',
        impact: 'Critical',
        tags: ['Land Law', 'NLC', 'Title Deed', 'Property'],
        content: 'The National Land Commission (NLC) has published procedural rules governing historical land injustice reviews and title regularizations. Landowners and legal practitioners are advised that all claims must conform to the 2026 evidentiary framework requiring surveyor certified beacon drawings and historical search extracts from the Land Registry.'
      },
      {
        id: 'bulletin-003',
        title: 'Supreme Court Directive on Article 47 Petitions: Strict 14-Day Service Timeline',
        category: 'judiciary',
        categoryLabel: 'Supreme Court Practice',
        date: '2026-08-05',
        summary: 'Supreme Court bench rules that constitutional petitions alleging breach of Fair Administrative Action must serve respondents within 14 days of filing or face automatic strike-out.',
        readTime: '2 min read',
        source: 'Supreme Court Registry',
        impact: 'High',
        tags: ['Constitutional Law', 'Article 47', 'Fair Administrative Action'],
        content: 'In a unanimous bench ruling, the Supreme Court emphasized that delays in serving administrative bodies undermine judicial efficiency. Failure to file proof of service within 14 business days will result in preliminary dismissal without prejudice.'
      },
      {
        id: 'bulletin-004',
        title: 'Parliamentary Bill: The Data Protection & Digital Evidence Amendment Bill 2026',
        category: 'legislation',
        categoryLabel: 'Legislative Update',
        date: '2026-08-02',
        summary: 'Proposed legislation introduces formal standards for electronic document admissibility, cryptographic hash validation, and cloud metadata in court proceedings.',
        readTime: '5 min read',
        source: 'National Assembly Gazette',
        impact: 'Medium',
        tags: ['Digital Evidence', 'Data Protection', 'Evidence Act'],
        content: 'The Data Protection & Digital Evidence Bill 2026 passed its second reading in Parliament. The Bill seeks to amend Section 106B of the Evidence Act (Cap. 80) by streamlining certificate of electronic evidence requirements for automated log files and cloud database records.'
      },
      {
        id: 'bulletin-005',
        title: 'Employment & Labor Relations Court: Ratio on Constructive Dismissal Claims',
        category: 'news',
        categoryLabel: 'Judicial Precedent Alert',
        date: '2026-07-28',
        summary: 'ELRC Court clarifies that unilateral reduction of employee responsibilities without salary alteration can ground a valid constructive dismissal petition.',
        readTime: '3 min read',
        source: 'ELRC Law Reporter',
        impact: 'Medium',
        tags: ['Employment Law', 'ELRC', 'Constructive Dismissal'],
        content: 'In a landmark judgment delivered at the Nairobi ELRC Court, the bench reiterated that an employer\'s substantial alteration of fundamental job duties without employee consent constitutes a repudiatory breach of the employment contract, entitling the employee to treat themselves as constructively dismissed.'
      },
      {
        id: 'bulletin-006',
        title: 'Tax Appeals Tribunal Circular: New Timelines for Appeals against KRA Assessments',
        category: 'legislation',
        categoryLabel: 'Tax Directive',
        date: '2026-07-22',
        summary: 'Tribunal issues binding guidance note requiring electronic lodgment of appeal bundles within 30 days of KRA Commissioner objection decisions.',
        readTime: '3 min read',
        source: 'Tax Appeals Tribunal Registry',
        impact: 'High',
        tags: ['Tax Law', 'KRA', 'Tribunal Appeals'],
        content: 'The Tax Appeals Tribunal (TAT) has issued Practice Note 1/2026 mandating digital filing of tax appeal memoranda and supporting audit documents. Appellants are required to attach full bank reconciliation statements and tax ledger copies.'
      },
      {
        id: 'bulletin-007',
        title: 'Public Procurement Administrative Review Board: Ruling on Bid Security Validity',
        category: 'judiciary',
        categoryLabel: 'Procurement Board Ruling',
        date: '2026-07-15',
        summary: 'PPARB affirms that minor clerical discrepancies in bank guarantees do not invalidate technical bids where intent remains clear.',
        readTime: '3 min read',
        source: 'PPARB Secretariat',
        impact: 'Medium',
        tags: ['Procurement Law', 'Tender Appeals', 'PPARB'],
        content: 'In a binding administrative review ruling, the Board held that procuring entities must apply the rule of proportionality when evaluating bid bonds. Disqualifying a bidder for typographical errors in bank guarantee headers violates fair competition principles under the Public Procurement and Asset Disposal Act.'
      },
      {
        id: 'bulletin-008',
        title: 'Environment & Land Court Directive: Mandatory Certified Beacon Surveys in Title Disputes',
        category: 'gazette',
        categoryLabel: 'Land Gazette Notice',
        date: '2026-07-10',
        summary: 'Chief Registrar issues practice direction requiring verified Director of Surveys beacon maps prior to setting down land injunction applications.',
        readTime: '4 min read',
        source: 'High Court ELC Division',
        impact: 'High',
        tags: ['Land Law', 'ELC', 'Boundary Dispute'],
        content: 'To curb vexatious boundary litigation, the Environment and Land Court now mandates that all applicants seeking interlocutory injunctions attach a survey report authenticated by the Survey of Kenya.'
      },
      {
        id: 'bulletin-009',
        title: 'Commercial Court Bench Note: Fast-Track Arbitral Award Enforcement Procedures',
        category: 'news',
        categoryLabel: 'Commercial Court Alert',
        date: '2026-07-04',
        summary: 'Commercial Division sets up dedicated fast-track registry for recognizing domestic and UNCITRAL international arbitration awards.',
        readTime: '3 min read',
        source: 'Commercial & Tax Division',
        impact: 'High',
        tags: ['Arbitration', 'Commercial Law', 'UNCITRAL'],
        content: 'The High Court Commercial Division has introduced streamlined registry procedures under Section 36 of the Arbitration Act. Applications for entry of arbitral awards as decrees will now be determined within 45 days of filing.'
      },
      {
        id: 'bulletin-010',
        title: 'Chief Justice Directive: Electronic Filing Fee Waivers for Indigent Litigants',
        category: 'judiciary',
        categoryLabel: 'Access to Justice Notice',
        date: '2026-06-28',
        summary: 'New judicial guidelines streamline pauperis applications allowing pro-bono advocates to request instant e-Filing fee waivers online.',
        readTime: '2 min read',
        source: 'Judiciary Administration',
        impact: 'Medium',
        tags: ['Pauperis', 'Access to Justice', 'Legal Aid'],
        content: 'Pursuant to Article 48 of the Constitution, the Chief Justice has authorized automated e-Filing fee exemption certificates for certified legal aid bodies and public defenders.'
      }
    ];

    let filtered = category === 'all' ? bulletins : bulletins.filter(b => b.category === category);
    const total = filtered.length;
    const totalPages = Math.ceil(total / limit) || 1;
    const startIndex = (page - 1) * limit;
    const paginated = filtered.slice(startIndex, startIndex + limit);

    // Dynamically resolve actual image URLs for paginated bulletins (NO AI, NO Unsplash)
    const enrichedBulletins = await Promise.all(
      paginated.map(async (b) => {
        const imageUrl = await fetchActualImageForBulletin(b);
        return { ...b, imageUrl };
      })
    );

    res.json({
      bulletins: enrichedBulletins,
      page,
      limit,
      total,
      totalPages,
      category,
      updatedAt: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch bulletins', message: e.message });
  }
});

app.post('/api/ai-case-finder', async (req, res) => {
  if (!enforceAiDailyLimit(req, res)) return;
  const { query = '', facts = '' } = req.body || {};
  const userPrompt = (query + ' ' + facts).trim();
  if (!userPrompt) {
    return res.status(400).json({ error: 'Factual scenario or query required' });
  }

  try {
    const classification = await classifyQueryJurisdiction(userPrompt);
    const searchResults = await searchWithRetry(userPrompt, 2, classification.jurisdiction || 'all', classification);

    const ai = getAiClient();
    let aiResponse = null;

    if (ai) {
      const models = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'];
      for (const model of models) {
        try {
          const sysPrompt = `You are eLegal Senior AI Judicial Assistant. 
The user has provided a factual legal scenario or question:
"${userPrompt}"

Analyze this scenario with high legal precision:
1. Identify the core LEGAL ISSUES raised.
2. List APPLICABLE CONSTITUTIONAL ARTICLES & STATUTORY SECTIONS (e.g. Constitution of Kenya, Penal Code, Land Act, Employment Act, Limitation of Actions Act).
3. Frame the RELEVANT LEGAL PRINCIPLES & RATIO DECIDENDI needed to win or advise on this case.
4. Recommend key PRECEDENTS / CASE LAW principles.
5. Provide a targeted 3-5 word search query optimal for legal databases.

Return ONLY a valid JSON object matching this structure:
{
  "issues": ["Issue 1", "Issue 2"],
  "statutes": [
    {"name": "Constitution of Kenya 2010", "section": "Article 47", "relevance": "Right to fair administrative action"},
    {"name": "Employment Act (Cap. 226)", "section": "Section 45", "relevance": "Unfair termination remedies"}
  ],
  "precedents": [
    {"case": "Landmark Precedent 1", "principle": "Core principle established by Court of Appeal"}
  ],
  "advice": "Clear, direct senior advocate legal guidance and tactical strategy.",
  "recommendedQuery": "optimal search keywords"
}`;

          const resp = await ai.models.generateContent({
            model,
            contents: sysPrompt,
            config: { responseMimeType: 'application/json' }
          });

          if (resp && resp.text) {
            try {
              aiResponse = JSON.parse(resp.text);
              break;
            } catch (pErr) {
              console.warn('[ai-case-finder] Failed to parse JSON from model:', pErr.message);
            }
          }
        } catch (err) {
          console.warn(`[ai-case-finder] Model ${model} attempt error:`, err.message);
        }
      }
    }

    if (!aiResponse) {
      const isLand = userPrompt.toLowerCase().includes('land') || userPrompt.toLowerCase().includes('property') || userPrompt.toLowerCase().includes('possession') || userPrompt.toLowerCase().includes('title');
      const isEmployment = userPrompt.toLowerCase().includes('employ') || userPrompt.toLowerCase().includes('work') || userPrompt.toLowerCase().includes('salary') || userPrompt.toLowerCase().includes('dismiss') || userPrompt.toLowerCase().includes('terminat');
      const isConst = userPrompt.toLowerCase().includes('right') || userPrompt.toLowerCase().includes('constitution') || userPrompt.toLowerCase().includes('fair') || userPrompt.toLowerCase().includes('police') || userPrompt.toLowerCase().includes('bail');

      aiResponse = {
        issues: [
          `Whether the factual scenario gives rise to a cause of action under ${isLand ? 'Land Law & Limitation of Actions' : isEmployment ? 'Employment Act 2007' : isConst ? 'Bill of Rights & Administrative Law' : 'Civil & Commercial Law'}.`,
          `What remedies, damages, or statutory relief are available under Kenyan jurisdiction.`
        ],
        statutes: isLand ? [
          { name: 'Limitation of Actions Act (Cap. 22)', section: 'Section 7 & 17', relevance: '12-year statutory bar and adverse possession principles' },
          { name: 'Land Registration Act No. 3 of 2012', section: 'Section 24', relevance: 'Rights of a registered proprietor subject to overriding interests' }
        ] : isEmployment ? [
          { name: 'Employment Act (Cap. 226)', section: 'Section 45 & 49', relevance: 'Requirements for fair reason and procedural fairness prior to termination' },
          { name: 'Constitution of Kenya 2010', section: 'Article 41', relevance: 'Right to fair labor practices' }
        ] : [
          { name: 'Constitution of Kenya 2010', section: 'Article 47', relevance: 'Right to expeditious, efficient, lawful, and fair administrative action' },
          { name: 'Civil Procedure Act (Cap. 21)', section: 'Section 1A & 1B', relevance: 'Overriding objective of the court to facilitate just resolution' }
        ],
        precedents: isLand ? [
          { case: 'Sisto Wambugu v Kamau Njuguna [1983] KECA 69', principle: 'Adverse possession requires open, peaceful, uninterrupted possession without consent of owner for over 12 years.' }
        ] : isEmployment ? [
          { case: 'Kenfreight (E.A.) Limited v Benson K. Nguti [2016] eKLR', principle: 'Summary dismissal without procedural hearing under Section 41 renders termination substantively unfair.' }
        ] : [
          { case: 'Dry Associates Limited v Capital Markets Authority [2012] eKLR', principle: 'Administrative decisions made in violation of natural justice are null and void ab initio.' }
        ],
        advice: `Based on legal precedent and statutory framework, litigants should file formal pleadings backed by certified supporting affidavits. Focus on establishing procedural compliance and statutory deadlines.`,
        recommendedQuery: isLand ? 'adverse possession land dispute 12 years' : isEmployment ? 'unfair termination procedural fairness employment act' : 'article 47 fair administrative action petition'
      };
    }

    res.json({
      query: userPrompt,
      classification,
      aiAnalysis: aiResponse,
      matchingCases: searchResults.slice(0, 8),
      totalMatches: searchResults.length
    });

  } catch (e) {
    console.error('AI Case Finder error:', e);
    res.status(500).json({ error: 'AI Case Finder execution failed', message: e.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/dev', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dev.html'));
});

let searchIndex = null;
let serverInitialized = false;

async function ensureInitialized() {
  if (serverInitialized) return;
  serverInitialized = true;
  const adminApps = admin.getApps();
  console.log(`[firebase] Admin SDK apps initialized: ${adminApps.length > 0 ? 'yes' : 'no'}`);
  try {
    initRepositoryStore();
  } catch (e) {
    console.warn('Failed to init repository store:', e.message);
  }
  try {
    await loadApiKeys();
  } catch (e) {
    console.warn('Failed to load API keys from Firestore:', e.message);
  }
  try {
    searchIndex = buildSearchIndex();
  } catch (e) {
    console.warn('Failed to build search index:', e.message);
  }
  fetchLatestKenyaLawItems().catch(err => console.warn('Background eKLR fetch warning:', err.message));
}


if (require.main === module) {
  app.listen(PORT, '0.0.0.0', async () => {
    console.log(`eLegal running at http://localhost:${PORT}`);
    await ensureInitialized();
  });
}

module.exports = {
  app,
  handler: async (req, res) => {
    await ensureInitialized();
    return app(req, res);
  },
  extractDocumentMetadata,
  extractKenyaLawDocumentInfo,
  normalizeKenyaLawSearchResults,
  resolveKenyaLawDocument,
  searchLocalIndex,
  buildSearchIndex,
  extractLinks,
  rankResults,
  tokenize,
  normalize,
  searchWithRetry,
  getLibrary,
  titleFromFilename,
  validateApiKey,
  createApiKey,
  generateApiKey
};
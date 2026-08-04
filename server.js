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
let firestoreDisabled = false;

function handleFirestoreError(err, contextMsg = 'Firestore error') {
  if (!err) return;
  const msg = String(err.message || err);
  const isUnauthenticated = err.code === 16 || msg.includes('UNAUTHENTICATED') || msg.includes('invalid authentication credentials');
  if (isUnauthenticated) {
    if (!firestoreDisabled) {
      firestoreDisabled = true;
      console.log(`[firestore] Cloud Firestore authentication is not configured; fallback to local App DB store active.`);
    }
  } else {
    console.warn(`[${contextMsg}]`, msg);
  }
}

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
  if (firestoreDisabled) return null;
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
    handleFirestoreError(e, 'apikeys: Firestore unauthenticated or unavailable');
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

const SUMMARIES_FILE = path.join(__dirname, 'data', 'repository', 'summaries.json');

function initSummariesStore() {
  const dir = path.join(__dirname, 'data', 'repository');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(SUMMARIES_FILE)) {
    fs.writeFileSync(SUMMARIES_FILE, JSON.stringify({ summaries: {}, updatedAt: new Date().toISOString() }, null, 2));
  }
}

function getSummaryCacheKey(docKey) {
  if (!docKey) return null;
  const cleanKey = String(docKey).trim().toLowerCase().replace(/https?:\/\//i, '').replace(/[^a-z0-9]/g, '_');
  return crypto.createHash('md5').update(cleanKey).digest('hex');
}

async function getCachedSummary(docKey) {
  const hashKey = getSummaryCacheKey(docKey);
  if (!hashKey) return null;

  initSummariesStore();

  // 1. Check local summaries file
  try {
    const raw = fs.readFileSync(SUMMARIES_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data.summaries && data.summaries[hashKey] && data.summaries[hashKey].summaryHtml) {
      console.log(`[summary-cache] Serving cached brief from local App DB for hash ${hashKey}`);
      return data.summaries[hashKey].summaryHtml;
    }
  } catch (e) {
    console.warn('[summary-cache] Error reading local summaries store:', e.message);
  }

  // 2. Check Firestore if available
  try {
    const db = getFirestore();
    if (db) {
      const doc = await db.collection('summaries').doc(hashKey).get();
      if (doc.exists && doc.data() && doc.data().summaryHtml) {
        const summaryHtml = doc.data().summaryHtml;
        console.log(`[summary-cache] Serving cached brief from Firestore for hash ${hashKey}`);
        saveCachedSummary(docKey, summaryHtml);
        return summaryHtml;
      }
    }
  } catch (e) {
    handleFirestoreError(e, 'summary-cache: Error reading Firestore summary cache');
  }

  // 3. Check repository metadata
  try {
    const docs = getRepositoryDocs();
    const repoDoc = docs.find(d => {
      const dKey = d.url || d.sourceUrl || d.citation || d.title;
      return getSummaryCacheKey(dKey) === hashKey || (d.id && String(docKey).includes(d.id));
    });
    if (repoDoc && repoDoc.summaryHtml) {
      console.log(`[summary-cache] Serving cached brief from repository metadata for doc: ${repoDoc.title}`);
      return repoDoc.summaryHtml;
    }
  } catch (e) {
    console.warn('[summary-cache] Error checking repository metadata summary:', e.message);
  }

  return null;
}

async function saveCachedSummary(docKey, summaryHtml, docMeta = {}) {
  const hashKey = getSummaryCacheKey(docKey);
  if (!hashKey || !summaryHtml) return;

  initSummariesStore();
  const now = new Date().toISOString();

  // 1. Save to local summaries file
  try {
    const raw = fs.readFileSync(SUMMARIES_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (!data.summaries) data.summaries = {};
    data.summaries[hashKey] = {
      docKey,
      title: docMeta.title || '',
      citation: docMeta.citation || '',
      summaryHtml,
      cachedAt: now
    };
    data.updatedAt = now;
    fs.writeFileSync(SUMMARIES_FILE, JSON.stringify(data, null, 2));
    console.log(`[summary-cache] Saved brief to local App DB store (hash: ${hashKey})`);
  } catch (e) {
    console.warn('[summary-cache] Failed to save local summary:', e.message);
  }

  // 2. Save to Firestore if available
  try {
    const db = getFirestore();
    if (db) {
      await db.collection('summaries').doc(hashKey).set({
        docKey,
        title: docMeta.title || '',
        citation: docMeta.citation || '',
        summaryHtml,
        cachedAt: now
      }, { merge: true });
      console.log(`[summary-cache] Saved brief to Firestore (hash: ${hashKey})`);
    }
  } catch (e) {
    handleFirestoreError(e, 'summary-cache: Failed to save Firestore summary');
  }

  // 3. Update matching repository doc in doc_metadata.json
  try {
    const docs = getRepositoryDocs();
    const idx = docs.findIndex(d => {
      const dKey = d.url || d.sourceUrl || d.citation || d.title;
      return getSummaryCacheKey(dKey) === hashKey || (d.id && String(docKey).includes(d.id));
    });
    if (idx >= 0) {
      docs[idx].summaryHtml = summaryHtml;
      docs[idx].summaryCachedAt = now;
      fs.writeFileSync(REPO_INDEX_FILE, JSON.stringify({ docs, updatedAt: now }, null, 2));
    }
  } catch (e) {
    console.warn('[summary-cache] Failed to update repository metadata with summary:', e.message);
  }
}

function isLegalDocument(doc) {
  if (!doc) return false;

  const title = String(doc.title || doc.label || '').trim();
  const citation = String(doc.citation || '').trim();
  const rawType = String(doc.type || '').trim();
  const url = String(doc.url || doc.sourceUrl || doc.readUrl || '').trim().toLowerCase();
  const snippets = Array.isArray(doc.snippets) ? doc.snippets.join(' ') : String(doc.snippets || '');

  if (title.length < 3) return false;

  // Filter out non-legal pages, blogs, news commentary sites, directory listings, search aggregators
  const bannedKeywords = [
    'techtrendske', 'blog', 'news', 'editorial', 'what the new law does',
    'all courts - kenya law', 'home - kenya law', 'search results', 'privacy policy',
    'terms of service', 'contact us', 'about us', 'subscribe', 'newsletter', 'login', 'signup',
    'googlef3644fe', 'sitemap', 'category/', 'tag/'
  ];
  for (const banned of bannedKeywords) {
    if (title.toLowerCase().includes(banned) || url.includes(banned)) {
      return false;
    }
  }

  // Precedents / Judgments / Rulings / Advisory Opinions
  const isCaseOrPrecedent =
    /\b(v|vs|versus)\b/i.test(title) ||
    /\[\d{4}\]\s*(KECA|KEHC|KESC|KEELRC|KLR|UKSC|ICJ|ICC|EACHR|BAILII)\b/i.test(title + ' ' + citation) ||
    /akn\/ke\/judgment\//i.test(url) ||
    /\b(civil appeal|criminal appeal|petition|miscellaneous cause|constitutional petition|advisory opinion|ruling|judgment|judgement)\b/i.test(title + ' ' + citation + ' ' + rawType);

  // Legislations / Acts / Constitutions / Statutes / Bills / Gazette Notices
  const isStatuteOrLegislation =
    /\b(act|statute|constitution|bill|cap\.|cap\s+\d+|code|gazette notice|legal notice|ordinance|rules|regulations)\b/i.test(title + ' ' + citation + ' ' + rawType) ||
    /akn\/ke\/(act|bill|gazette)\//i.test(url) ||
    /^(the|an)?\s*[A-Z][A-Za-z0-9\s,-]+(Act|Code|Constitution|Bill|Ordinance)\b/.test(title);

  // Known official legal document repositories
  const isOfficialRepoDoc = (url.includes('kenyalaw.org/akn/') || url.includes('bailii.org') || url.includes('worldlii.org') || url.includes('law.cornell.edu') || url.includes('justia.com')) &&
    !url.endsWith('/all/') && !url.endsWith('/judgments/') && !url.endsWith('/acts/');

  const validTypes = ['constitution', 'legislation', 'bill', 'gazette notice', 'judgment', 'ruling', 'advisory opinion', 'precedent', 'statute', 'act', 'code'];
  const isExplicitLegalType = rawType && validTypes.includes(rawType.toLowerCase());

  if (isExplicitLegalType && (isCaseOrPrecedent || isStatuteOrLegislation || isOfficialRepoDoc)) {
    return true;
  }

  return isCaseOrPrecedent || isStatuteOrLegislation;
}

function getRepositoryDocs() {
  try {
    initRepositoryStore();
    const data = JSON.parse(fs.readFileSync(REPO_INDEX_FILE, 'utf8'));
    const rawDocs = data.docs || [];
    return rawDocs.filter(d => isLegalDocument(d));
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
    if (!isLegalDocument(docMeta)) {
      console.log(`[saveDocToRepository] Filtering out non-legal document: "${docMeta.title || docMeta.label}"`);
      return docMeta;
    }

    initRepositoryStore();
    const docs = getRepositoryDocs();
    const enriched = enrichDocumentMetadata(docMeta);
    if (!isLegalDocument(enriched)) {
      return docMeta;
    }
    
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

async function generateGroqBrief({ title, citation, year, type, sourceUrl, text }) {
  const groqApiKey = process.env.GROQ_API_KEY ;
  if (!groqApiKey) {
    console.error('[groq-summarize] GROQ_API_KEY is missing');
    throw new Error('GROQ_API_KEY is missing');
  }

  const docText = text ? text.substring(0, 15000) : '';

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
      <strong>Citation:</strong> ${citation || 'Official Record'} | <strong>Year:</strong> ${year || 'N/A'} | <strong>Classification:</strong> ${type || 'Legal Authority'} | <span style="color: #0d9488; font-weight: 600;">⚡ Groq Llama-3.3 AI Brief</span>
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

  const groqModels = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];
  let lastError = null;

  for (const model of groqModels) {
    try {
      console.log(`[groq-summarize] Requesting Groq model ${model}...`);
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${groqApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'user', content: prompt }
          ],
          temperature: 0.1
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`[groq-summarize] Groq model ${model} HTTP error ${response.status}: ${errText}`);
        lastError = new Error(`Groq HTTP ${response.status}: ${errText}`);
        continue;
      }

      const data = await response.json();
      let summaryHtml = data?.choices?.[0]?.message?.content || '';
      summaryHtml = summaryHtml.replace(/```html/gi, '').replace(/```/g, '').trim();

      if (summaryHtml && summaryHtml.length > 100) {
        console.log(`[groq-summarize] Successfully generated brief with Groq model ${model} (${summaryHtml.length} chars)`);
        return summaryHtml;
      }
    } catch (err) {
      console.error(`[groq-summarize] Exception calling Groq model ${model}:`, err.message || err);
      lastError = err;
    }
  }

  throw lastError || new Error('Failed to generate summary with Groq models');
}

app.post('/api/summarize-doc', async (req, res) => {
  const { title = 'Legal Document', sourceUrl = '', text = '', year = '', type = '', citation = '' } = req.body || {};
  const docText = text ? text.substring(0, 15000) : '';
  const docKey = sourceUrl || citation || title;

  // 1. Check Overall App DB summary cache (local file & Firestore & repository metadata)
  try {
    const cachedHtml = await getCachedSummary(docKey);
    if (cachedHtml) {
      console.log(`[summarize-doc] Serving cached brief from App DB for: "${title}"`);
      return res.json({
        success: true,
        source: 'cached_app_db',
        summaryHtml: cachedHtml
      });
    }
  } catch (cacheErr) {
    console.warn('[summarize-doc] App DB summary cache check warning:', cacheErr.message);
  }

  // 2. Call Groq AI if not cached in App DB
  try {
    const groqHtml = await generateGroqBrief({ title, citation, year, type, sourceUrl, text: docText });

    // Save generated brief into App DB (local store & Firestore)
    await saveCachedSummary(docKey, groqHtml, { title, citation, year, type, sourceUrl });

    return res.json({
      success: true,
      source: 'groq_ai_lawyer_brief',
      summaryHtml: groqHtml
    });
  } catch (err) {
    console.error('[summarize-doc] Groq AI summarization error log:', err.message || err);
    return res.status(500).json({
      success: false,
      error: 'Groq AI summarization failed',
      details: err.message || String(err)
    });
  }
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

let aiClient = null;
function getAiClient() {
  if (!aiClient && process.env.GEMINI_API_KEY) {
    aiClient = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        }
      }
    });
  }
  return aiClient;
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
    ? 'General internet legal databases, international precedents, US/UK/Commonwealth court judgments, ICJ, UN Treaties, WorldLII, BAILII, Justia, Cornell Law, and foreign legal repositories (beyond eKLR)'
    : 'Kenya Law statutes/eKLR and global internet legal precedents across all international jurisdictions';

  const systemPrompt = `You are eLegal, an advanced legal research engine.
Conduct focused legal research for the query: "${query}".
Target Jurisdiction / Scope: ${scopeText}.

Search Strategy Instructions:
1. ${isInternational ? 'Since this is an out-of-Kenya international query, research broadly across the general internet legal resources (e.g. WorldLII, BAILII, Justia, Cornell Law, ICJ, UN Law, foreign courts, legal journals) apart from eKLR.' : 'Search Kenya Law (eKLR) and primary legal sources.'}
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

  const models = ['gemini-3.6-flash', 'gemini-flash-latest'];

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
        console.warn(`[gemini] Quota limit hit on ${model}, falling back to web search.`);
        break;
      }
      console.warn(`[gemini] Model ${model} search grounding error:`, err.message);
    }
  }

  return [];
}

async function searchFastWeb(query, source = 'all') {
  const isIntl = source === 'international';
  const scopeQuery = source === 'kenya' 
    ? `${query} site:kenyalaw.org`
    : isIntl
    ? `${query} case law precedent statute judgment filetype:pdf OR site:worldlii.org OR site:bailii.org OR site:justia.com OR site:law.cornell.edu`
    : `${query} case law precedent statute legal judgment filetype:pdf`;

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
      const isKenya = actualUrl.includes('kenyalaw.org');
      const isPdfUrl = actualUrl.endsWith('.pdf') || actualUrl.includes('.pdf?') || title.toLowerCase().includes('[pdf]');

      results.push({
        title,
        label: title.replace(/^(The|An|A)\s+/i, '').trim(),
        citation: title,
        url: actualUrl,
        readUrl: actualUrl,
        source: isKenya ? 'kenyalaw' : 'international',
        isPdf: isPdfUrl,
        fileType: isPdfUrl ? 'PDF' : 'DOC',
        score: isPdfUrl ? 90 : 80,
        snippets: [actualUrl]
      });
      if (results.length >= 20) break;
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

    // Requirement: Prioritize PDF and official document results while keeping others significant
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

    // Classification alignment boost
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

  const effectiveSource = (classification && ['kenya', 'international'].includes(classification.jurisdiction)) 
    ? classification.jurisdiction 
    : source;

  const stopWords = new Set(['v', 'vs', 'r', 're', 'the', 'and', 'or', 'in', 'of', 'to', 'at', 'a', 'an', 'for']);
  const sigTokens = normalizedQuery.toLowerCase().split(/\W+/).filter(t => t.length > 1 && !stopWords.has(t));

  // 1. Tokenized local index lookup & persistent repository lookup
  const localResults = searchLocalIndex(normalizedQuery);
  const repoDocs = getRepositoryDocs();
  const repoMatches = repoDocs.filter(doc => {
    const target = `${doc.title || ''} ${doc.citation || ''} ${doc.type || ''} ${doc.source || ''} ${doc.year || ''}`.toLowerCase();
    if (sigTokens.length > 0) {
      return sigTokens.some(t => target.includes(t));
    }
    return false;
  }).map(d => {
    const titleLower = (d.title || '').toLowerCase();
    const matchesAll = sigTokens.length > 0 && sigTokens.every(t => titleLower.includes(t));
    return { ...d, score: matchesAll ? 95 : 60, source: 'local' };
  });

  // 2. Parallel AI Google Search Grounding & KenyaLaw direct lookup
  const geminiPromise = searchWithGeminiGrounding(normalizedQuery, effectiveSource);
  const kenyaLawPromise = (effectiveSource === 'all' || effectiveSource === 'kenya' || effectiveSource === 'mixed') 
    ? fetchKenyaLawDirect(normalizedQuery)
    : Promise.resolve([]);

  const timeoutPromise = new Promise(resolve => setTimeout(() => resolve([]), 9000));

  let [geminiResults, kenyaLawResults] = await Promise.all([
    Promise.race([geminiPromise, timeoutPromise]),
    Promise.race([kenyaLawPromise, timeoutPromise])
  ]);

  // Fallback to fast web search if gemini returns empty
  if (!geminiResults || geminiResults.length === 0) {
    geminiResults = await searchFastWeb(normalizedQuery, effectiveSource);
  }

  const combined = [];
  const seen = new Set();

  for (const item of [...geminiResults, ...repoMatches, ...localResults, ...kenyaLawResults]) {
    if (!isLegalDocument(item)) continue;
    const key = (item.url || item.title || '').toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      const enriched = enrichDocumentMetadata(item);
      if (isLegalDocument(enriched)) {
        combined.push(enriched);
        saveDocToRepository(enriched);
      }
    }
  }

  // If no results from web or API, fallback to repository docs
  if (combined.length === 0 && repoDocs.length > 0) {
    for (const item of repoDocs) {
      const key = (item.url || item.title || '').toLowerCase();
      if (key && !seen.has(key)) {
        seen.add(key);
        combined.push(item);
      }
    }
  }

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

app.get('/api/suggestions', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q || q.length < 1) {
    return res.json({ suggestions: [] });
  }

  const docs = getRepositoryDocs();
  const exactPrefixMatches = [];
  const wordBoundaryMatches = [];
  const containsMatches = [];
  const seenKeys = new Set();

  const legalTopics = [
    { title: 'Robbery with Violence - Section 296(2) Penal Code', citation: 's.296(2)', type: 'Topic', category: 'Precedent' },
    { title: 'Land Disputes Tribunal Act & Property Rights', citation: 'Cap. 303', type: 'Topic', category: 'Statute' },
    { title: 'Employment & Labour Relations Court Judgments', citation: 'ELRC', type: 'Topic', category: 'Precedent' },
    { title: 'Constitutional Petitions & Fundamental Rights', citation: 'Art. 22', type: 'Topic', category: 'Precedent' },
    { title: 'Penal Code (Cap 63 Laws of Kenya)', citation: 'Cap. 63', type: 'Statute', category: 'Statute' },
    { title: 'Civil Procedure Act & Rules (Cap 21)', citation: 'Cap. 21', type: 'Statute', category: 'Statute' },
    { title: 'Evidence Act (Cap 80 Laws of Kenya)', citation: 'Cap. 80', type: 'Statute', category: 'Statute' },
    { title: 'Law of Contract Act (Cap 23)', citation: 'Cap. 23', type: 'Statute', category: 'Statute' },
    { title: 'Companies Act 2015 Laws of Kenya', citation: 'Act 17 of 2015', type: 'Statute', category: 'Statute' },
    { title: 'Children Act 2022', citation: 'Act 29 of 2022', type: 'Statute', category: 'Statute' },
    { title: 'Constitution of Kenya 2010', citation: 'Constitution', type: 'Statute', category: 'Statute' },
    { title: 'Land Registration Act 2012', citation: 'Act 3 of 2012', type: 'Statute', category: 'Statute' },
    { title: 'Environment and Land Court Judgments', citation: 'ELC', type: 'Topic', category: 'Precedent' },
    { title: 'Court of Appeal Criminal Appeals & Bail', citation: 'KECA', type: 'Topic', category: 'Precedent' },
    { title: 'Judicial Review & Orders of Certiorari/Prohibition', citation: 'Order 53', type: 'Topic', category: 'Precedent' }
  ];

  function addCandidate(item) {
    const key = (item.title || '').toLowerCase();
    if (!key || seenKeys.has(key)) return;

    const titleLower = key;
    const citLower = (item.citation || '').toLowerCase();
    const isStatute = item.category === 'Statute' || (item.type || '').toLowerCase().includes('act') || (item.type || '').toLowerCase().includes('statute') || (item.type || '').toLowerCase().includes('code');

    const formattedItem = {
      title: item.title,
      citation: item.citation || '',
      type: item.type || (isStatute ? 'Statute' : 'Judgment'),
      url: item.url || item.sourceUrl || item.readUrl || '',
      category: isStatute ? 'Statute' : 'Precedent'
    };

    const safeQ = q.toLowerCase();
    const titleWords = titleLower.split(/[^a-z0-9]+/);
    const citWords = citLower.split(/[^a-z0-9]+/);

    if (titleLower.startsWith(safeQ) || citLower.startsWith(safeQ)) {
      seenKeys.add(key);
      exactPrefixMatches.push(formattedItem);
    } else if (titleWords.some(w => w.startsWith(safeQ)) || citWords.some(w => w.startsWith(safeQ))) {
      seenKeys.add(key);
      wordBoundaryMatches.push(formattedItem);
    } else if (titleLower.includes(safeQ) || citLower.includes(safeQ)) {
      seenKeys.add(key);
      containsMatches.push(formattedItem);
    }
  }

  // 1. Process repo docs
  for (const doc of docs) {
    if (!isLegalDocument(doc)) continue;
    addCandidate(doc);
  }

  // 2. Process curated legal topics
  for (const topic of legalTopics) {
    addCandidate(topic);
  }

  const combined = [...exactPrefixMatches, ...wordBoundaryMatches, ...containsMatches].slice(0, 12);
  res.json({ suggestions: combined });
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
      handleFirestoreError(dbErr, 'apikeys: Firestore fetch error');
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
      handleFirestoreError(dbErr, 'apikeys: Firestore fetch error');
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
  const sourceOverride = req.query.source || 'all';
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
    const results = await searchWithRetry(q, 2, effectiveSource, classification);

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

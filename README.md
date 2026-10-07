# ⚖️ eLegal — Modern Legal E-Repository & AI Intelligence Engine

<p align="center">
  <img src="Screenshot from 2026-08-04 20-09-01.png" alt="eLegal Modern Legal E-Repository Interface" width="100%" style="border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.12);">
</p>

> **Seamlessly access millions of precedents, statutes, constitutional provisions, and official legal records — perfectly organized for comprehensive legal research, academic study, and legal engineering.**

---

## 📌 Executive Summary & Architecture Overview

**eLegal** is a full-stack, enterprise-grade legal e-repository and AI-powered intelligence platform. Built for advocates, judges, legal researchers, law students, and legaltech developers, eLegal aggregates legal jurisprudence from national databases (such as Kenya Law / eKLR) and international legal repositories (WorldLII, BAILII, CanLII, AustLII, CourtListener, Law.Cornell.edu).

```
 ┌─────────────────────────────────────────────────────────────────────────┐
 │                        eLegal Platform                                   │
 └─────────────────────────────────────────────────────────────────────────┘
                                      │
       ┌──────────────────────────────┼──────────────────────────────┐
       ▼                              ▼                              ▼
 ┌───────────────┐            ┌───────────────────┐            ┌───────────────────┐
 │  Main App     │            │  AI Case Finder   │            │  Developer API     │
 │  lexshub.xyz  │            │  ai.lexshub.xyz   │            │  lexshub.xyz/dev   │
 │               │            │                   │            │                   │
 │  Home         │            │  Scenario Analysis│            │  API Keys          │
 │  E-Repository │            │  Chat Assistant   │            │  Documentation     │
 │  Bulletins    │            │  Precedent Match  │            │  Tester            │
 │  Practice     │            │                   │            │                   │
 │  Saved        │            │                   │            │                   │
 └───────┬───────┘            └─────────┬─────────┘            └─────────┬─────────┘
         │                              │                                │
         └──────────────────────────────┼────────────────────────────────┘
                                        ▼
                         ┌─────────────────────────────┐
                         │    Express REST API Server   │
                         │         (server.js)         │
                         └──────────────┬──────────────┘
                                        │
     ┌────────────────────────────────┼────────────────────────────────┐
     ▼                                ▼                                ▼
 ┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
 │  ML Query Classifier │  │ Dual Persistence Engine│  │ Google Gemini AI    │
 │(src/ml-classifier.js)│  │ Firestore + Encrypted│  │ Legal Assistant      │
 │                      │  │ Local AES-256 Storage│  │                      │
 └──────────────────────┘  └──────────────────────┘  └──────────────────────┘
```

---

## 🌐 Applications & Hosting

### Main Application (`lexshub.xyz`)
The primary legal research platform providing search, document reading, bulletins, and practice areas.

**Live URLs:**
- Homepage & Search: `https://lexshub.xyz/`
- E-Repository: `https://lexshub.xyz/e-repository`
- Bulletins & Digest: `https://lexshub.xyz/bulletins`
- Practice Areas: `https://lexshub.xyz/practice`
- Saved Documents: `https://lexshub.xyz/saved`
- Document Reader: `https://lexshub.xyz/read`
- Developer API: `https://lexshub.xyz/dev`

### AI Case Finder (`ai.lexshub.xyz`)
A standalone AI-powered legal analysis application.

**Live URLs:**
- AI Case Finder: `https://ai.lexshub.xyz/`

---

## 🚀 Key Features

* **Multi-Jurisdictional Legal Search**: Unified query interface covering **Kenya Law (eKLR)** statutes and precedents, as well as **International Case Law** from Commonwealth and global jurisdictions.
* **On-the-Fly ML Jurisdiction & Domain Classification**: Automatic machine learning query intent detection classifying searches into targeted legal domains (Constitutional, Criminal, Land & Property, Civil, Commercial, Labour, Administrative).
* **Smart KenyaLaw Resolution Engine**: Seamless conversion of Kenya Law AKN XML links and HTML views (`/caselaw/cases/view/...`) directly into downloadable and viewable PDF streams (`/caselaw/cases/export/.../pdf`).
* **Universal Legal Document Reader**: In-browser document viewer powered by **PDF.js** and **Mammoth.js** supporting full-text OCR, Word DOCX parsing, zoom, page jump, print, and raw text inspection.
* **AI Case Finder**: Paste client factual scenarios, legal disputes, contract terms, or constitutional issues to perform deep legal grounding, issue framing, statutory indexing, and binding precedent analysis powered by Google Grounding.
* **Citation Generator**: Automatic generation of legal citations in standard legal formats: **OSCOLA**, **Bluebook**, **APA**, **Harvard**, and **eKLR**.
* **Enterprise Developer API**: Secure REST API guarded by API keys (`el_...`), featuring rate limiting (60 req/min), Firestore key persistence, and AES-256-GCM local fallback encryption.
* **Offline Local Storage**: One-click local document saving and session persistence across page navigations.

---

## 📖 System Components & Codebase Structure

### 1. Main Search Workspace (`public/index.html`)
The primary web dashboard providing a modern legal search engine interface.
* **Jurisdiction Tabs**: Toggle between `All Repositories`, `Kenya Law (eKLR)`, and `International Law`.
* **Category Filters**: Filter search results by `All`, `Precedents`, `Statutes`, or `Saved`.
* **Real-time Autocomplete & Suggestion Bar**: Interactive search suggestions with predictive ML jurisdiction badges.
* **Result Cards**: Displays title, citation, year, jurisdiction badge, document type badge (PDF, DOCX, Judgment, Legislation), and direct action buttons (Read, Preview Modal, Save).
* **Session Restoration**: Uses browser `sessionStorage` to retain query input, active scroll position, and search results when returning from the Document Reader.

### 2. Document Reader & AI Workspace (`public/read.html`)
A standalone, distraction-free document reading studio.
* **Canvas PDF Renderer**: High-performance canvas page-by-page rendering using `pdfjs-dist` with zoom (+ / -) controls, direct page navigation, and download triggers.
* **Mammoth Word Reader**: Converts native DOCX Word files directly into clean HTML on-the-fly.
* **Inspector Sidebar**:
  * **Overview Tab**: Key metadata (Title, Citation, Year, Document Type, Source Repository).
  * **Plain Text Tab**: Full text extraction view for quick copy-pasting.
  * **AI Assistant Tab**: Interactive legal chat interface powered by Google Gemini API.
  * **Citation Tab**: Instant formatting of citations across major academic and legal styles.

### 3. AI Case Finder (`public/ai.html`)
A standalone AI-powered legal analysis interface.
* **Scenario Analysis**: Paste client factual scenarios for deep legal grounding and issue framing.
* **Chat Assistant**: Interactive AI chat drawer for follow-up legal questions.
* **Precedent Matching**: Identifies binding precedents and ratio decidendi using Google Grounding.

### 4. Developer Portal (`public/dev.html`)
A dedicated API developer dashboard.
* **API Key Generator**: Instant single-click creation of `el_...` API keys.
* **Key Lifecycle Dashboard**: View active key counts, request counts, creation dates, and deactivation toggles.
* **Interactive API Tester**: Direct browser-based REST endpoint testing suite.

### 5. Express REST Server (`server.js`)
The core backend server handling API requests, search orchestration, document resolution, and persistence.
* **`classifyQueryJurisdiction(q)`**: Leverages `src/ml-classifier.js` to determine target jurisdiction and legal domain.
* **`searchFastWeb(query, source)`**: Scrapes and parses legal search results using DuckDuckGo, Wikipedia Legal API, and direct repository indices.
* **`resolveKenyaLawDocument(url, title)`**: Resolves KenyaLaw web URLs to direct PDF export URLs.
* **`validateApiKey` Middleware**: Enforces rate limiting, validates active API keys against Firestore or local AES-256 store.

### 6. Machine Learning Classifier (`src/ml-classifier.js`)
An open-source, zero-dependency probabilistic NLP classifier.
* **Term Weight Scoring**: Evaluates query tokens against legal lexicons (e.g. *habeas corpus*, *ratio decidendi*, *adverse possession*, *kenyalaw*, *eKLR*, *KECA*, `KEHC`, *KESC*).
* **Outputs**: Returns domain classification, confidence score, and recommended target jurisdiction.

---

## 📑 User Manual & Operating Guide

### A. Performing Legal Research
1. Open the **eLegal Homepage** (`https://lexshub.xyz/`).
2. Type your query or legal case title in the main search bar (e.g., `"Rylands v Fletcher"` or `"Article 43 Constitution of Kenya"` or `"adverse possession 12 years"`).
3. Select your desired jurisdiction tab:
    * **🌐 All Repositories**: Searches across all local and international legal databases.
    * **🇰🇪 Kenya Law (eKLR)**: Limits results strictly to Kenyan law (Constitutions, Acts, High Court & Court of Appeal judgments).
    * **🌍 International Law**: Limits results to Commonwealth precedents, UK Supreme Court, US case law, and international tribunal decisions.
4. Press **Enter** or click **Search**.

### B. Reading & Inspecting Documents
1. In the search results list, click **"Read document"** on any record.
2. The **Document Reader Studio** (`https://lexshub.xyz/read`) will launch.
3. Use the top toolbar to zoom in/out, jump to specific pages, or download the original file.
4. Click **Back to Search** to return to your exact search position with preserved results.

### C. Using the AI Case Finder
1. Navigate to **AI Case Finder** (`https://ai.lexshub.xyz/`).
2. Paste client factual scenarios, legal disputes, contract terms, or constitutional issues into the input area.
3. Click **Analyze Scenario with Legal AI** to perform deep legal grounding, issue framing, statutory indexing, and binding precedent analysis.
4. Use the floating **AI Case Finder** button to open the chat assistant for follow-up questions.

### D. Saving Documents for Offline Access
1. Click the **Save** button on any search result card or in the Document Reader.
2. Access saved records anytime by clicking the **Saved** filter tab on the homepage.
3. Saved documents are retained locally in browser storage without needing an account.

---

## 🌐 Developer API Documentation

All API requests must include your API key either via HTTP header or query parameter:
```http
Authorization: Bearer el_demo_key_12345
```
*or*
```http
X-API-Key: el_demo_key_12345
```

### Endpoints Summary

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/api/search` | `GET` | Executes live/cached targeted legal search with ML classification & document URLs |
| `/api/document` | `GET` | Extracts full text, clean HTML body, and structured NLP legal brief for any document URL |
| `/read` | `GET` | Renders the interactive eLegal document reader UI (embeddable via iframe) |
| `/api/resolve` | `GET` | Resolves Kenya Law URLs into direct PDF export links & metadata |
| `/api/library` | `GET` | Fetches featured repository precedents and statutes with document links |
| `/api/keys` | `POST` | Generates a new developer API key |
| `/api/keys` | `GET` | Lists API keys for an authenticated user |
| `/api/keys/:keyId` | `DELETE`| Deactivates an existing API key |
| `/api/health` | `GET` | Returns system status and health |
| `/api/ai-case-finder` | `POST` | Analyzes legal scenarios and returns grounded legal analysis |

---

### Zero-CORS HTML / JavaScript Quick Start

Developers can call the eLegal API directly from any browser client or `.html` file with zero CORS friction:

```html
<!DOCTYPE html>
<html>
<head>
  <title>eLegal API Demo</title>
</head>
<body>
  <h2>Legal Search Results</h2>
  <ul id="results"></ul>

  <script>
    async function searchPrecedents() {
      // Live search without CORS blocking
      const res = await fetch('https://elegal-hteg.onrender.com/api/search?q=adverse+possession&fresh=true');
      const data = await res.json();
      
      const list = document.getElementById('results');
      data.results.forEach(doc => {
        const li = document.createElement('li');
        li.innerHTML = `
          <strong>${doc.title}</strong> (${doc.year})<br>
          <a href="${doc.actualDocumentUrl}" target="_blank">Download Document / PDF</a> | 
          <a href="${doc.readUrl}" target="_blank">Open in Reader</a>
        `;
        list.appendChild(li);
      });
    }
    searchPrecedents();
  </script>
</body>
</html>
```

---

### Sample Request & Response: `/api/search`

#### Request:
```bash
curl -X GET "https://elegal-hteg.onrender.com/api/search?q=adverse%20possession&source=kenya&fresh=true" \
     -H "X-API-Key: el_demo_key_12345"
```

#### Response JSON:
```json
{
  "query": "adverse possession",
  "source": "kenya",
  "classification": {
    "jurisdiction": "kenya",
    "domain": "Land & Property Law",
    "confidence": 0.94
  },
  "results": [
    {
      "id": "sisto_wambogu_1983",
      "title": "Sisto Wambugu v Kamau Njuguna [1983] KECA 69 (KLR)",
      "label": "Sisto Wambugu v Kamau Njuguna",
      "citation": "Sisto Wambugu v Kamau Njuguna [1983] KECA 69 (KLR)",
      "year": "1983",
      "type": "Judgment",
      "source": "Kenya Law (Court of Appeal)",
      "url": "https://kenyalaw.org/akn/ke/judgment/keca/1983/69/eng@1983-11-14",
      "sourceUrl": "https://kenyalaw.org/akn/ke/judgment/keca/1983/69/eng@1983-11-14",
      "documentUrl": "https://kenyalaw.org/akn/ke/judgment/keca/1983/69/eng@1983-11-14/source",
      "actualDocumentUrl": "https://kenyalaw.org/akn/ke/judgment/keca/1983/69/eng@1983-11-14/source",
      "pdfUrl": "/api/pdf-proxy?sourceUrl=https%3A%2F%2Fkenyalaw.org...",
      "contentUrl": "/api/document?sourceUrl=https%3A%2F%2Fkenyalaw.org...",
      "readUrl": "/read?title=Sisto%20Wambugu...&sourceUrl=...",
      "isPdf": true,
      "cached": false,
      "score": 98
    }
  ],
  "total": 1
}
```

---

## 🔍 SEO Strategy & Search Engine Optimization

eLegal is fully optimized for organic search discovery by search engines (Google, Bing, DuckDuckGo):

1. **Comprehensive XML Sitemap (`/public/sitemap.xml`)**:
   - Lists all core application pages, deep search routes, bulletins, practice areas, and API docs.
   - Includes separate sitemap entries for the main app (`lexshub.xyz`) and AI app (`ai.lexshub.xyz`).
   - Annotated with `changefreq` and `priority` for high-value legal content.
2. **Robots Control (`/public/robots.txt`)**:
   - Explicit crawling permissions pointing search engine crawlers directly to the XML sitemaps.
3. **Structured Data (JSON-LD)**:
   - Formatted using `schema.org/LegalService`, `schema.org/WebSite`, and `schema.org/SoftwareApplication` standards on `index.html` and `ai.html`.
4. **Social Sharing Metadata**:
   - High-contrast OpenGraph (`og:title`, `og:image`, `og:description`) and Twitter Card tags on all pages.
5. **Indexable Content**:
   - Homepage hero, E-Repository search results, Bulletins & Daily Cause Lists, Practice Areas, and Saved documents are all fully indexable with unique page titles, meta descriptions, and semantic headings.

---

## 💻 Local Installation & Setup

### Prerequisites
* **Node.js**: v18.0.0 or higher
* **npm**: v9.0.0 or higher

### Step-by-Step Setup
1. **Clone repository**:
   ```bash
   git clone https://github.com/your-org/e-legal.git
   cd e-legal
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Configure Environment Variables**:
   Create a `.env` file in the root directory (refer to `.env.example`):
   ```env
   PORT=3000
   GEMINI_API_KEY=your_google_gemini_api_key_here
   APP_DB_ENCRYPTION_KEY=elegal_app_db_secret_key_v1_secure_2026
   APP_MODE=main
   ```
   - `APP_MODE=main` serves the main app (`public/index.html`) at the root route.
   - `APP_MODE=ai` serves the AI app (`public/ai.html`) at the root route.

4. **Start the Application**:
   ```bash
   npm start
   ```

5. **Access in Browser**:
   Open [http://localhost:3000](http://localhost:3000)

---

## ⚙️ Deployment Options

* **Cloud Run / Docker**: The app is container-ready, binding to port `3000` on `0.0.0.0`.
* **Render / Heroku / Railway**: Deploys directly using `npm start`.
* **Single Repo, Multiple Apps**: Deploy the same repository twice with different `APP_MODE` values:
  - **Main app** (`lexshub.xyz`): set `APP_MODE=main` in environment variables.
  - **AI app** (`ai.lexshub.xyz`): set `APP_MODE=ai` in environment variables.
  Both deployments share the same backend API, database, and AI engine.

---

## 📄 License & Attribution

© 2026 **eLegal Platform**. All rights reserved.  
Developed by **emojisudios** (Contact: 0707865597).

---

## 🤝 Contributing

1. Fork the repository.
2. Create a feature branch (`git checkout -b feature/amazing-feature`).
3. Commit your changes (`git commit -m 'Add amazing feature'`).
4. Push to the branch (`git push origin feature/amazing-feature`).
5. Open a Pull Request.

---

## 📞 Support

For support, email **0707865597** or open an issue on GitHub.

---

## 🔗 Quick Links

- **Main App**: [https://lexshub.xyz](https://lexshub.xyz)
- **AI Case Finder**: [https://ai.lexshub.xyz](https://ai.lexshub.xyz)
- **Developer API**: [https://lexshub.xyz/dev](https://lexshub.xyz/dev)
- **GitHub Repository**: [https://github.com/maroontech-so/eLegal](https://github.com/maroontech-so/eLegal)

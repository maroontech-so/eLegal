# eLegal

<img src="public/homepage.png">

A professional legal research app for browsing, searching, and reading eLegal documents. It combines metadata from a local library with Kenya Law search results, then streams PDFs from their source URLs into an in-browser reader.

## What It Does

- Loads the local document library on the home screen (metadata only).
- Separates **precedents** from **statutes** for clearer research.
- Searches Kenya Law's public document search API for records.
- Resolves Kenya Law record pages to their exact source PDFs.
- Streams resolved PDFs on demand from their source URLs — no local PDF storage.
- Opens PDFs in a browser reader powered by PDF.js with temporary session storage.
- Shows animated loading states, shimmer skeletons, and stable layouts while data is loading.
- Exposes JSON endpoints for search, library browsing, health checks, and Kenya Law PDF resolution.

## Project Structure

```text
.
├── public/
│   ├── index.html        # Main search and library UI
│   ├── logo.html         # Branding page for the eLegal logo
│   ├── logo.png          # eLegal logo image (256x256)
│   ├── favicon.ico       # App favicon (32x32)
│   ├── read.html         # PDF reader page (streams from source URLs)
│   └── lib/              # PDF.js browser assets
├── test/                 # Node test files and fixtures
├── package.json
├── server.js             # Express server, search, and API logic
```

## Requirements

- Node.js
- npm

## Install

```bash
npm install
```

## Run

```bash
npm start
```

Then open:

```text
http://localhost:3000
```

The server listens on `0.0.0.0` using port `3000` by default. You can override the port:

```bash
PORT=4000 npm start
```

## Test

```bash
npm test
```

The current tests cover Kenya Law metadata extraction, result normalization, and local document metadata behavior.

## Developer Portal

The developer portal at `/dev` provides Firebase Auth-based account management and API key generation.

### Authentication

Sign in with one of:
- **Google** — OAuth via Google account
- **GitHub** — OAuth via GitHub account
- **Email/Password** — Create an account or sign in with existing credentials

After signing in, you can:
- Generate API keys tied to your Firebase user account
- View, copy, and delete your API keys
- API keys are stored in Firestore under `/apikeys/{userId}/keys/{keyId}` with usage tracking (request count, last used timestamp)

### API Key Management

- Each user can have one **active** key at a time
- Generating a new key automatically pauses any existing active key
- Keys can be **paused/resumed** or **permanently deleted** from the dev portal

### API Key Usage

Include your API key in the `X-API-Key` request header for authenticated endpoints:

```bash
curl -H "X-API-Key: el_your_key_here" "http://localhost:3000/api/search?q=land+act"
```

### Firebase Setup

The app uses Firebase Authentication (for the dev portal) and Firestore (for API key storage and usage tracking).

To configure:
1. Create a Firebase project at https://console.firebase.google.com/
2. Enable Authentication providers (Google, GitHub, Email/Password)
3. Create a Firestore database
4. Set up a service account key (`firebase-service-account.json`) for the server:
   - Go to Project Settings → Service Accounts
   - Click "Generate new private key"
   - Save as `firebase-service-account.json` in the project root
5. Add the web app Firebase config to the dev portal (already included in `public/dev.html`)

## How The App Works

### 1. Home Screen Library

When the home screen loads, the frontend calls:

```text
GET /api/library
```

The server returns the metadata-only library (precedents and statutes) with reader links.

### 2. eLegal Search

Search requests call:

```text
GET /api/search?q=<query>
```

The server:

1. Calls Kenya Law's document search API.
3. Falls back to parsing Kenya Law search pages if needed.
4. Resolves the top Kenya Law records into exact downloadable PDFs where possible.
5. Returns ranked results to the UI.

### 4. Exact PDF Resolution

When a Kenya Law record needs to be opened, the frontend calls:

```text
GET /api/resolve?url=<kenya-law-record-url>&title=<optional-title>
```

The server:

1. Fetches the Kenya Law record page.
2. Finds the `/source` PDF download link.
3. Returns a `/read/...` URL with the source URL embedded.

### 5. Reader

Reader URLs look like:

```text
/read/<filename>.pdf?title=<document-title>&sourceUrl=<source-pdf-url>
```

The reader fetches the PDF from the source URL via the server proxy, stores it temporarily in session storage, and renders pages using PDF.js. The PDF is cleared from session storage when the user navigates away.

## API Developer Portal

eLegal provides a free, open API for developers to integrate legal research into their applications.

### Getting an API Key

1. Click the `<API/>` button in the top-right corner of the homepage
2. Or visit `http://localhost:3000/dev`
3. Sign in with Google, GitHub, or Email/Password
4. Click **Generate API Key**
5. Copy your key and include it in the `X-API-Key` header of your requests

### Authentication

Include your API key in the `X-API-Key` request header:

```bash
curl -H "X-API-Key: el_abc123..." "http://localhost:3000/api/search?q=land+act"
```

### Rate Limits

- **100 requests per minute** per API key
- Exceeding the limit returns HTTP `429` with a `resetAt` timestamp

### Available Endpoints

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| `GET` | `/api/search?q=<query>` | Search statutes and Kenya Law records | Required |
| `GET` | `/api/library` | List all local documents | Required |
| `GET` | `/api/resolve?url=<url>` | Resolve a Kenya Law URL to a PDF | Required |
| `GET` | `/api/health` | Check API health | None |
| `POST` | `/api/keys` | Generate a new API key | Required |
| `GET` | `/api/keys` | List your API keys | Required |
| `PATCH` | `/api/keys/:keyId` | Update a key label or active status | Required |
| `DELETE` | `/api/keys/:keyId` | Delete an API key | Required |
| `GET` | `/api/docs` | Get full API documentation (JSON) | None |

### Code Examples

**JavaScript (fetch):**
```js
const API_KEY = 'el_your_key';
const res = await fetch('http://localhost:3000/api/search?q=land+act', {
  headers: { 'X-API-Key': API_KEY }
});
const data = await res.json();
```

**Python:**
```python
import requests
res = requests.get('http://localhost:3000/api/search?q=land+act',
  headers={'X-API-Key': 'el_your_key'})
data = res.json()
```

**cURL:**
```bash
curl -H "X-API-Key: el_your_key" \
  "http://localhost:3000/api/search?q=land+act"
```

## API Reference

### `GET /api/library`

Returns all local library files grouped by category. Requires API key.

### `GET /api/search?q=<query>`

Searches local statute content and Kenya Law records. Requires API key.

## Adding Documents

Documents are discovered through Kenya Law search results and resolved on demand. No local PDF storage is required — the app streams PDFs from their source URLs when you open them.

## UI Notes

The home screen is intentionally minimal, but it includes:

- A stable layout to avoid content jumping while data loads.
- Skeleton cards shaped like the final document cards.
- Shimmer effects across loading placeholders.
- Small animated loading details and rotating waiting messages.
- A two-column library view on desktop and a single-column layout on mobile.

## Troubleshooting

### Reader opens but PDF is blank

The reader now fetches PDFs from source URLs via the server proxy. If it cannot load or render the PDF, it should show a visible error message instead of staying blank.

Check:

- The source URL is accessible from the server.
- The reader URL includes a valid `sourceUrl` parameter.
- The server can reach the source URL (no firewall or CORS blocking).

### Kenya Law result does not open locally

Some Kenya Law records may not expose a `/source` PDF link. In that case `/api/resolve` returns a 404-style error.

Check server logs for:

```text
resolveKenyaLawDocument error
```

### Search returns no results

Search queries are sent to Kenya Law's public document search API. If the API is down or returns no matches, the results will be empty.

### Port is already in use

Run on another port:

```bash
PORT=4000 npm start
```

## Development Notes

- The server is plain Express.
- The frontend is a single static HTML file with inline CSS and JavaScript.
- PDF rendering uses PDF.js assets in `public/lib/`.
- PDFs are streamed from source URLs on demand — no local PDF storage or caching.
- Search ranking is intentionally simple and local to `server.js`.

## Scripts

```bash
npm start
```

Starts the Express app.

```bash
npm test
```

Runs the Node test suite.

## Developer Setup

<img src="public/Pasted image.png">
```bash
npm install
npm start
```

Then open:

- **App:** `http://localhost:3000`
- **API docs:** `http://localhost:3000/api/docs` (JSON)
- **Developer portal:** `http://localhost:3000/dev`

## Deployment

### Environment Variables

Copy `.env.example` to `.env` and fill in your Firebase credentials:

```bash
cp .env.example .env
```

Edit `.env` and replace the `FIREBASE_SERVICE_ACCOUNT` value with your actual Firebase service account JSON (the full contents of `firebase-service-account.json`).

| Variable | Description | Default |
|---|---|---|
| `PORT` | Server port | `3000` |
| `FIREBASE_PROJECT_ID` | Firebase project ID | `elegal-v1` |
| `FIREBASE_SERVICE_ACCOUNT` | Full Firebase service account JSON | — |

### Local Development

```bash
npm install
cp .env.example .env
# Edit .env with your Firebase credentials
npm start
```

Then open `http://localhost:3000`.

### Hosting

For hosting:

- **Railway**: Connect your GitHub repo; Railway auto-detects Node.js and runs `npm start`.
- **Render**: Set `start command` to `npm start` in the Render dashboard.
- **Fly.io**: `fly launch` then `fly deploy`.


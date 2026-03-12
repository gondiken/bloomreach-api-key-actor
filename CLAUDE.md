# Bloomreach API Key Creator Actor

## What this is
An Apify actor that automates creating API keys in Bloomreach Engagement via browser automation (Playwright). It navigates to the API settings page, creates a new key, and returns `{ project_token, secret_api_key, api_key_id }`.

## Tech stack
- **Runtime:** Node.js ESM (`"type": "module"`)
- **Framework:** Apify SDK v3 + Playwright (NOT Crawlee)
- **Docker base:** `apify/actor-node-playwright-chrome:20`
- **Proxy:** Apify residential proxy (`groups-RESIDENTIAL` via `proxy.apify.com:8000`)

## Project structure
```
src/main.js              # All actor logic (single file)
.actor/actor.json        # Apify actor metadata
.actor/input_schema.json # Input schema for Apify UI
.actor/Dockerfile        # Docker build config
package.json             # Dependencies (apify + playwright only)
```

## Authentication
Two auth methods:
1. **Cookie injection (preferred)** — pass exported browser cookies as `cookies` input to skip login entirely. Login is blocked by invisible reCAPTCHA, so this is the viable path.
2. **Email/password (blocked)** — reCAPTCHA prevents automated login even with residential proxy.

## How to export cookies
In browser DevTools console while logged into `demoapp.bloomreach.com`:
```js
copy(JSON.stringify(await cookieStore.getAll()))
```
Paste the result into the `cookies` field of actor input.

## Key selectors (Bloomreach UI)
- Login: `input[name="username"]`, `input[type="password"]`, `button:has-text("Log in")`
- API page URL: `demoapp.bloomreach.com/p/{projectSlug}/project-settings/api`
- Project token: UUID in a readonly input field
- Add key: `text=Add key` link
- Secret modal: text "Secret API key" with readonly input
- Key table: rows with key name, API Key ID (in input), masked secret

## Debugging
Every step saves screenshots to Apify Key-value store:
`LOGIN_PAGE`, `BEFORE_LOGIN_CLICK`, `AFTER_LOGIN_CLICK`, `API_PAGE`, `ADD_KEY_MODAL`, `SECRET_MODAL`, `AFTER_CLOSE`, `ERROR_SCREENSHOT`

## Running locally
```bash
npm install
npm start  # requires APIFY_TOKEN and input.json
```

## Running on Apify
Push with `apify push`, then run from Apify console with input JSON.

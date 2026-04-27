# Bloomreach API Key Creator Actor

## What this is
An Apify actor that automates creating Bloomreach Engagement projects, API keys, and setting permissions via browser automation (Playwright). Returns `{ project_token, secret_api_key, api_key_id }`.

## Tech stack
- **Runtime:** Node.js ESM (`"type": "module"`)
- **Framework:** Apify SDK v3 + Playwright (NOT Crawlee)
- **Docker base:** `apify/actor-node-playwright-chrome:20`
- **Proxy:** Apify residential proxy (`groups-RESIDENTIAL` via `proxy.apify.com:8000`) — only used for email/password login, skipped for cookie auth

## Project structure
```
src/main.js              # All actor logic (single file)
.actor/actor.json        # Apify actor metadata (v2.0.0)
.actor/input_schema.json # Input schema for Apify UI
.actor/Dockerfile        # Docker build config
package.json             # Dependencies (apify + playwright only)
```

## Authentication
Bloomreach centralized its login at `https://brx.login.bloomreach.com/login` (as of 2026-04). After signing in there, the app lands on a different landing page, but direct navigation to `demoapp.bloomreach.com/p/{slug}/...` still works as long as the demoapp `session` cookie is present.

Two auth methods:
1. **Cookie injection (preferred)** — pass exported browser cookies as `cookies` input to skip login entirely. Login is blocked by invisible reCAPTCHA, so this is the only viable path.
2. **Email/password (blocked)** — reCAPTCHA on `brx.login.bloomreach.com` prevents automated login even with residential proxy.

### How to export cookies
1. Log in via `https://brx.login.bloomreach.com/login`.
2. Navigate to `demoapp.bloomreach.com` so the demoapp session cookie is set on that origin.
3. Use the **Cookie-Editor** browser extension (NOT DevTools console) to export ALL cookies including httpOnly ones. The critical one is the httpOnly `session` cookie on `demoapp.bloomreach.com` (JWT format). The actor checks for httpOnly cookies and warns if none are found.

## Actor pipeline (4 phases)

### Phase 0: Cookie loading
Loads cookies into browser context. Supports both array (Cookie-Editor JSON export) and string (`name=value; name2=value2`) formats. Validates httpOnly cookies are present.

### Phase 1: Project creation (optional)
Only runs if `newProjectName` is provided. Creates a Sandbox project cloned from `sourceProject` (default: `temp2`).
1. Navigate to `/projects/new`
2. Select target workspace from "Account name" dropdown (default: `Campaign Agent`, configurable via `workspaceName`). Tags the dropdown via DOM mutation, reads its current value, only clicks if it doesn't already match — and **verifies the displayed value changed** after clicking. Throws if verification fails. Skips silently for single-workspace users with no "Account name" label.
3. Fill project name
4. Open `e-select-box` dropdown → select "Sandbox"
5. Select "Data structure from existing project" → search and select source project
6. Click Next → Create project
7. Wait 20s for project generation, then navigate to API settings. Polls the "Project token" selector with up to 6 attempts (15s wait between tries) to handle slow provisioning.

### Phase 2: API key creation
1. Extract **project token** (UUID from readonly input)
2. **Detect group type** — checks badge/chip DOM elements for "Public" vs "Private", falls back to table column headers ("API Token" = Public, "API Key ID" = Private)
3. **Create Private API group** (if current group is Public):
   - Click group dropdown → "New group" → select "Private access" (exact match via `getByText`) → fill group name → "Create group"
   - Dismiss Angular modal backdrop (Escape → force-click → DOM removal)
4. **Add key**: Click "+ Add key" → fill key name in empty text input → "Create"
5. **Extract secret**: Wait for "Secret API key" modal → scan inputs for 64-char alphanumeric value
6. **Extract API Key ID**: TreeWalker from key name text → walk up ancestors checking inputs for long alphanumeric values
7. Close modal

### Phase 3: Set group permissions
Sets Get/Set permissions on three tabs, then saves:
1. **Customer properties** tab (active by default): clicks all visible unchecked checkboxes (covers "New properties" + "Other" headers which cascade to sub-rows)
2. **Events** tab: click tab → click all visible unchecked checkboxes ("New events" + "Other")
3. **Catalogs** tab: click tab → click all visible unchecked checkboxes ("Action")
4. Scroll to top → click "Save Changes" button

## Key technical lessons learned

### Bloomreach UI (Angular SPA)
- Uses custom components: `e-select-box`, `e-ui-button`, `button.button-wrapper`
- Modal backdrop (`ui-modal-backdrop` in `cdk-overlay-container`) persists after modals close and blocks pointer events. Must dismiss via Escape → force-click → JS DOM removal.
- New projects default to "Default Public" API group which does NOT show "Secret API key" modal after key creation. Must create a Private group first.
- Checkboxes ARE native `input[type="checkbox"]` — `page.evaluate` with `.click()` works.
- Tab elements are `<div>` tags (no `role="tab"` attribute). Found via `innerText` match + visibility check (`offsetParent !== null`), using last match as fallback.
- `children.length === 0` is unreliable for finding leaf text nodes — many elements have child spans/icons.

### Playwright patterns that work
- `page.getByText('text', { exact: true })` to avoid strict mode violations when partial text matches multiple elements
- `page.evaluate()` for complex DOM operations — avoids Playwright's strict mode entirely
- `cb.offsetParent !== null` inside evaluate to check element visibility
- TreeWalker for finding text nodes and walking up DOM to find nearby inputs/checkboxes
- Force-click (`{ force: true }`) to bypass intercepting overlays
- `page.click('text=Add key')` for simple text-based clicks

### Patterns that DON'T work
- `text=Private` matches description paragraphs containing the word — use exact match
- `el.textContent.trim() === 'GROUP PERMISSIONS'` with `el.children.length === 0` — fails because the heading element has child elements
- TreeWalker with `break` after first text match — "Other" appears in multiple places, must continue searching
- `[role="tab"]` selectors — Bloomreach doesn't use ARIA roles on tabs
- Scoping DOM searches by finding a section heading and walking up — fragile, prefer flat "click all visible checkboxes" approach
- `page.goto(..., { waitUntil: 'networkidle' })` — Bloomreach's Angular SPA has persistent websockets/polling so `networkidle` rarely fires and causes 60s+ hangs. Use `'domcontentloaded'` + explicit `waitForSelector` for the readiness signal (e.g. `text=Project token`).

## Debugging
Screenshots saved to Apify KV store at every step:
- Phase 1: `CREATE_PROJECT_PAGE`, `ACCOUNT_DROPDOWN_OPENED`, `ACCOUNT_SELECTED`, `DROPDOWN_OPENED`, `PROJECT_TYPE_SELECTED`, `BEFORE_EXISTING_PROJECT`, `CREATE_PROJECT_FILLED`, `CREATE_PROJECT_STEP2`, `CREATE_PROJECT_SUBMITTED`
- Phase 2: `API_PAGE`, `GROUP_DROPDOWN_OPENED`, `NEW_GROUP_MODAL`, `PRIVATE_ACCESS_SELECTED`, `GROUP_NAME_FILLED`, `GROUP_CREATED`, `ADD_KEY_MODAL`, `KEY_NAME_FILLED`, `AFTER_KEY_CREATE`, `AFTER_CLOSE`
- Phase 3: `PERMISSIONS_CUSTOMER_PROPERTIES`, `PERMISSIONS_EVENTS`, `PERMISSIONS_CATALOGS`, `PERMISSIONS_SAVED`
- Errors: `ERROR_SCREENSHOT`, `ERROR_BLANK_PAGE`, `ERROR_NO_TOKEN`, `ERROR_NO_SECRET`, `ERROR_NO_KEY_ID`, `ERROR_API_PAGE_TIMEOUT`, `ERROR_WORKSPACE_NOT_SELECTED`

## Input fields
| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `newProjectName` | No | — | Name for new project (triggers Phase 1) |
| `sourceProject` | No | `temp2` | Project to clone data structure from |
| `workspaceName` | No | `Campaign Agent` | Account/workspace selected in the "Account name" dropdown during Phase 1 |
| `projectSlug` | No | — | Use existing project (skip Phase 1) |
| `cookies` | Yes* | — | Exported browser cookies (array or string) |
| `keyName` | No | `forge_run` | Name for API key and Private group |
| `email` | No | — | Login email (blocked by CAPTCHA) |
| `password` | No | — | Login password (blocked by CAPTCHA) |

*Either `cookies` or `email`+`password` required, but cookies is the only working auth method.

## Running locally
```bash
npm install
npm start  # requires APIFY_TOKEN and input.json
```

## Running on Apify
Push with `apify push`, then run from Apify console with input JSON.

## Git remote
`https://github.com/gondiken/bloomreach-api-key-actor.git` (master branch)

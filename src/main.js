import { Actor } from 'apify';
import playwright from 'playwright';

await Actor.init();

const input = await Actor.getInput();
const {
    newProjectName = null,
    sourceProject = 'temp2',
    projectSlug = null,
    email,
    password,
    keyName = 'forge_run',
    cookies = null,
} = input;

// Determine which project to create the API key in
const targetProject = newProjectName || projectSlug;
if (!targetProject) {
    throw new Error('Provide either newProjectName (to create a new project) or projectSlug (to use existing)');
}
if (!cookies && (!email || !password)) {
    throw new Error('Provide either cookies OR email+password');
}

// Skip proxy when using cookies — session may be tied to original IP
const launchOptions = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
};

if (!cookies) {
    launchOptions.proxy = {
        server: 'http://proxy.apify.com:8000',
        username: 'groups-RESIDENTIAL',
        password: process.env.APIFY_PROXY_PASSWORD,
    };
    console.log('Using residential proxy (email/password login)');
} else {
    console.log('Skipping proxy (cookie auth — session is tied to original IP)');
}

const browser = await playwright.chromium.launch(launchOptions);

const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
});
const page = await context.newPage();

// Monitor failed network requests for debugging
page.on('response', response => {
    if (response.status() >= 400) {
        console.log(`HTTP ${response.status()}: ${response.url()}`);
    }
});

async function saveScreenshot(name) {
    const buf = await page.screenshot({ fullPage: true });
    await Actor.setValue(name, buf, { contentType: 'image/png' });
    console.log(`Screenshot saved: ${name}`);
}

// Helper: load cookies into browser context
async function loadCookies() {
    if (!cookies) return;

    console.log(`Loading ${Array.isArray(cookies) ? cookies.length : 'string'} cookies...`);

    let cookieArray = cookies;

    if (typeof cookies === 'string') {
        cookieArray = cookies.split(';').map(c => {
            const [name, ...rest] = c.trim().split('=');
            return {
                name: name.trim(),
                value: rest.join('=').trim(),
                domain: '.bloomreach.com',
                path: '/',
            };
        });
    }

    if (Array.isArray(cookieArray)) {
        const playwrightCookies = cookieArray.map(c => {
            let domain = c.domain || '.bloomreach.com';
            if (domain && !domain.startsWith('.') && !domain.match(/^\d/)) {
                domain = '.' + domain;
            }
            const validSameSite = { strict: 'Strict', lax: 'Lax', none: 'None' };
            const sameSite = validSameSite[(c.sameSite || '').toLowerCase()] || 'Lax';

            return {
                name: c.name,
                value: c.value,
                domain,
                path: c.path || '/',
                secure: c.secure !== undefined ? c.secure : true,
                httpOnly: c.httpOnly || false,
                sameSite,
            };
        });

        await context.addCookies(playwrightCookies);
        console.log(`Loaded ${playwrightCookies.length} cookies`);

        const httpOnlyCount = playwrightCookies.filter(c => c.httpOnly).length;
        console.log(`Cookie names: ${playwrightCookies.map(c => c.name).join(', ')}`);
        console.log(`httpOnly cookies: ${httpOnlyCount}/${playwrightCookies.length}`);
        if (httpOnlyCount === 0) {
            console.warn('WARNING: No httpOnly cookies found! Session cookies are usually httpOnly.');
            console.warn('Use a browser extension like "Cookie-Editor" to export ALL cookies including httpOnly ones.');
        }
    }
}

// Helper: handle login if needed
async function handleLoginIfNeeded() {
    await page.waitForTimeout(5000);

    const bodyText = await page.locator('body').innerText().catch(() => '');
    console.log(`Page title: ${await page.title()}`);
    console.log(`Page URL: ${page.url()}`);
    console.log(`Body text (first 300): ${bodyText.substring(0, 300)}`);

    // Check if page is blank (SPA didn't render)
    if (bodyText.trim().length === 0) {
        console.warn('WARNING: Page body is empty — SPA did not render.');
        console.log('Waiting 10 more seconds for SPA...');
        await page.waitForTimeout(10000);

        const bodyTextRetry = await page.locator('body').innerText().catch(() => '');
        if (bodyTextRetry.trim().length === 0) {
            await saveScreenshot('ERROR_BLANK_PAGE');
            throw new Error(
                'Page is blank after cookie injection. Use "Cookie-Editor" browser extension to export ALL cookies including httpOnly ones.'
            );
        }
    }

    // Check for login page
    let loginFrame = page;
    let foundPasswordInput = await page.locator('input[type="password"]').count() > 0;

    if (!foundPasswordInput) {
        for (const f of page.frames()) {
            const count = await f.locator('input[type="password"]').count().catch(() => 0);
            if (count > 0) {
                loginFrame = f;
                foundPasswordInput = true;
                break;
            }
        }
    }

    if (!foundPasswordInput) return; // Already logged in

    console.log('Login page detected.');
    await saveScreenshot('LOGIN_PAGE');

    const allInputs = await loginFrame.locator('input').all();
    const visibleInputs = [];
    for (const inp of allInputs) {
        if (await inp.isVisible()) visibleInputs.push(inp);
    }

    if (visibleInputs.length < 2) {
        await saveScreenshot('ERROR_NO_INPUTS');
        throw new Error(`Expected at least 2 visible inputs, found ${visibleInputs.length}`);
    }

    let emailIdx = 0;
    let passwordIdx = -1;
    for (let i = 0; i < visibleInputs.length; i++) {
        const type = await visibleInputs[i].getAttribute('type');
        if (type === 'password') { passwordIdx = i; break; }
    }
    if (passwordIdx === -1) passwordIdx = 1;
    if (passwordIdx > 0) emailIdx = passwordIdx - 1;

    await visibleInputs[emailIdx].fill(email);
    await visibleInputs[passwordIdx].fill(password);
    await saveScreenshot('BEFORE_LOGIN_CLICK');

    const btnSelectors = [
        'button:has-text("Log in")',
        'button:has-text("Login")',
        'button[type="submit"]',
        'input[type="submit"]',
    ];

    let clicked = false;
    for (const sel of btnSelectors) {
        if (await loginFrame.locator(sel).count() > 0) {
            await loginFrame.locator(sel).first().click();
            clicked = true;
            break;
        }
    }
    if (!clicked) {
        await loginFrame.getByRole('button', { name: /log in/i }).click();
    }

    await page.waitForTimeout(2000);
    await saveScreenshot('AFTER_LOGIN_CLICK');

    try {
        await page.waitForSelector('input[type="password"]', { state: 'hidden', timeout: 15000 });
        console.log('Login successful. URL:', page.url());
    } catch {
        await saveScreenshot('LOGIN_FAILED');
        throw new Error('Login failed — password input still visible after 15s');
    }
}

try {
    // ========== PHASE 0: Load cookies ==========
    await loadCookies();

    // ========== PHASE 1: Create new project (if requested) ==========
    if (newProjectName) {
        console.log(`\n=== PHASE 1: Creating new project "${newProjectName}" ===`);

        // Step 1.1: Navigate to project creation page
        console.log('Navigating to project creation page...');
        await page.goto('https://demoapp.bloomreach.com/projects/new', {
            waitUntil: 'networkidle',
            timeout: 60000,
        });

        await handleLoginIfNeeded();

        // Make sure we're on the project creation page after login
        if (!page.url().includes('/projects/new')) {
            console.log('Redirected after login, navigating back to project creation...');
            await page.goto('https://demoapp.bloomreach.com/projects/new', {
                waitUntil: 'networkidle',
                timeout: 60000,
            });
        }

        await page.waitForTimeout(3000);

        // Dismiss any error banners that might overlay the form
        const closeBtn = page.locator('text=Error!').locator('..').locator('button, [class*="close"]');
        if (await closeBtn.count() > 0) {
            console.log('Dismissing error banner...');
            await closeBtn.first().click({ force: true }).catch(() => {});
            await page.waitForTimeout(500);
        }

        await saveScreenshot('CREATE_PROJECT_PAGE');

        // Step 1.2: Fill project name
        console.log(`Filling project name: ${newProjectName}`);
        const projectNameInput = page.locator('input[placeholder="Name your project"]');
        await projectNameInput.waitFor({ timeout: 15000 });
        await projectNameInput.fill(newProjectName);

        // Step 1.3: Select "Sandbox" from Project type dropdown
        console.log('Selecting Sandbox project type...');

        // Dump all selects on the page for debugging
        const selectDebug = await page.evaluate(() => {
            const selects = [...document.querySelectorAll('select')];
            return selects.map((s, i) => ({
                index: i,
                name: s.name,
                id: s.id,
                class: s.className?.substring(0, 60),
                value: s.value,
                optionCount: s.options.length,
                options: [...s.options].map(o => ({ value: o.value, text: o.text.trim() })),
                visible: s.offsetParent !== null,
            }));
        });
        console.log(`Found ${selectDebug.length} <select> elements on page:`);
        for (const s of selectDebug) {
            console.log(`  select[${s.index}]: name=${s.name} id=${s.id} value="${s.value}" visible=${s.visible} options=${JSON.stringify(s.options.map(o => o.text))}`);
        }

        // Find the select that has "Sandbox" as an option and select it
        let projectTypeSelected = await page.evaluate(() => {
            const selects = [...document.querySelectorAll('select')];
            for (const sel of selects) {
                const opts = [...sel.options];
                const sandboxOpt = opts.find(o => o.text.trim() === 'Sandbox');
                if (sandboxOpt) {
                    sel.value = sandboxOpt.value;
                    sel.dispatchEvent(new Event('change', { bubbles: true }));
                    sel.dispatchEvent(new Event('input', { bubbles: true }));
                    return { found: true, value: sandboxOpt.value };
                }
            }
            return { found: false };
        });
        console.log(`Project type selection result: ${JSON.stringify(projectTypeSelected)}`);

        if (!projectTypeSelected.found) {
            // If no native select found, try Playwright selectOption on all selects
            const allSelects = await page.locator('select').all();
            for (let i = 0; i < allSelects.length; i++) {
                try {
                    await allSelects[i].selectOption('Sandbox');
                    console.log(`Selected Sandbox via selectOption on select[${i}]`);
                    projectTypeSelected = { found: true };
                    break;
                } catch {
                    // Not this select
                }
            }
        }

        if (!projectTypeSelected.found) {
            await saveScreenshot('ERROR_PROJECT_TYPE');
            throw new Error('Could not find Project type dropdown with Sandbox option');
        }

        await page.waitForTimeout(500);
        await saveScreenshot('PROJECT_TYPE_SELECTED');

        // Step 1.4: Click "Data structure from existing project" radio button
        console.log('Selecting "Data structure from existing project"...');
        await page.locator('text=Data structure from existing project').click();
        await page.waitForTimeout(1000);

        // Step 1.5: Select source project from "Existing project" dropdown
        // This is a custom dropdown with a search field
        console.log(`Selecting existing project: ${sourceProject}`);
        await saveScreenshot('BEFORE_EXISTING_PROJECT');

        // Try native <select> first
        let existingSelected = false;
        const allSelects2 = await page.locator('select').all();
        for (const sel of allSelects2) {
            const options = await sel.locator('option').allTextContents();
            if (options.some(o => o.includes(sourceProject))) {
                await sel.selectOption({ label: sourceProject });
                console.log(`Selected ${sourceProject} via native <select>`);
                existingSelected = true;
                break;
            }
        }

        if (!existingSelected) {
            // Custom dropdown: click to open, search, click result
            // Try clicking "Select existing project" text or the dropdown near "Existing project" label
            const trigger = page.locator('text=Select existing project').first();
            if (await trigger.count() > 0) {
                await trigger.click();
            } else {
                // Click the dropdown element after the "Existing project" label
                await page.evaluate(() => {
                    const labels = [...document.querySelectorAll('*')];
                    const label = labels.find(el => el.textContent.trim() === 'Existing project');
                    if (label) {
                        const next = label.nextElementSibling || label.parentElement.querySelector('[class*="select"], [class*="dropdown"]');
                        if (next) next.click();
                    }
                });
            }
            await page.waitForTimeout(500);

            // Type in the search field to filter
            const searchInput = page.locator('input[placeholder="Search..."]');
            if (await searchInput.count() > 0) {
                console.log('Typing in search field...');
                await searchInput.fill(sourceProject);
                await page.waitForTimeout(1000);
            }

            // Click the matching option in the dropdown list
            await page.getByText(sourceProject, { exact: true }).click();
            console.log(`Selected ${sourceProject} via custom dropdown`);
        }

        await page.waitForTimeout(500);
        await saveScreenshot('CREATE_PROJECT_FILLED');

        // Step 1.6: Click "Next"
        console.log('Clicking Next...');
        await page.locator('button:has-text("Next")').click();
        await page.waitForTimeout(3000);
        await saveScreenshot('CREATE_PROJECT_STEP2');

        // Step 1.7: Click "Create project" at bottom right (no changes needed on this page)
        console.log('Clicking Create project...');
        const createBtn = page.locator('button:has-text("Create project")');
        await createBtn.scrollIntoViewIfNeeded();
        await createBtn.click();
        await page.waitForTimeout(3000);
        await saveScreenshot('CREATE_PROJECT_SUBMITTED');

        // Step 1.8: Wait for project to be generated (expect 403 initially)
        console.log('Project submitted. Waiting 15 seconds for project generation...');
        await page.waitForTimeout(15000);

        // Step 1.9: Navigate to the new project's API settings
        console.log(`Navigating to new project API settings: /p/${newProjectName}/project-settings/api`);
        await page.goto(`https://demoapp.bloomreach.com/p/${newProjectName}/project-settings/api`, {
            waitUntil: 'networkidle',
            timeout: 60000,
        });

        // If still 403/loading, retry with increasing waits
        for (let attempt = 1; attempt <= 3; attempt++) {
            const bodyCheck = await page.locator('body').innerText().catch(() => '');
            if (bodyCheck.includes('Project token') || bodyCheck.includes('API')) {
                console.log('API page loaded successfully.');
                break;
            }
            console.log(`API page not ready yet (attempt ${attempt}/3), waiting 15 more seconds...`);
            await page.waitForTimeout(15000);
            await page.goto(`https://demoapp.bloomreach.com/p/${newProjectName}/project-settings/api`, {
                waitUntil: 'networkidle',
                timeout: 60000,
            });
        }

    } else {
        // ========== No project creation — go directly to existing project ==========
        console.log(`\n=== Skipping project creation, using existing project: ${projectSlug} ===`);

        await page.goto(`https://demoapp.bloomreach.com/p/${projectSlug}/project-settings/api`, {
            waitUntil: 'networkidle',
            timeout: 60000,
        });

        await handleLoginIfNeeded();

        // Navigate to API settings if login redirected elsewhere
        if (!page.url().includes('project-settings/api')) {
            await page.goto(`https://demoapp.bloomreach.com/p/${projectSlug}/project-settings/api`, {
                waitUntil: 'networkidle',
                timeout: 30000,
            });
        }
    }

    // ========== PHASE 2: API Key Creation ==========
    console.log('\n=== PHASE 2: API Key Creation ===');

    console.log('On API page. URL:', page.url());
    await page.waitForTimeout(3000);
    await saveScreenshot('API_PAGE');

    // Grab Project Token
    await page.waitForSelector('text=Project token', { timeout: 15000 });

    let projectToken = '';

    const allPageInputs = await page.locator('input[readonly], input[disabled], input.read-only').all();
    for (const inp of allPageInputs) {
        const val = await inp.inputValue();
        if (val && val.match(/^[a-f0-9-]{36}$/)) {
            projectToken = val;
            console.log(`Found project token: ${projectToken}`);
            break;
        }
    }

    if (!projectToken) {
        const pageText = await page.textContent('body');
        const uuidMatch = pageText.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/);
        if (uuidMatch) {
            projectToken = uuidMatch[0];
            console.log(`Found project token via regex: ${projectToken}`);
        } else {
            await saveScreenshot('ERROR_NO_TOKEN');
            throw new Error('Could not find project token');
        }
    }

    // Click "+ Add key"
    console.log('Clicking Add key...');
    await page.click('text=Add key');
    await page.waitForTimeout(1000);
    await saveScreenshot('ADD_KEY_MODAL');

    // Fill key name
    const modalInput = page.locator('input[type="text"]').last();
    await modalInput.fill(keyName);

    // Click Create
    await page.click('button:has-text("Create")');
    console.log('Key created, waiting for secret modal...');
    await page.waitForTimeout(2000);
    await saveScreenshot('SECRET_MODAL');

    // Extract secret API key
    await page.waitForSelector('text=Secret API key', { timeout: 10000 });

    let secretApiKey = '';
    const modalInputs = await page.locator('.modal input, [role="dialog"] input, [class*="modal"] input, [class*="dialog"] input').all();
    for (const inp of modalInputs) {
        const val = await inp.inputValue();
        if (val && val.length > 30 && !val.includes('-')) {
            secretApiKey = val;
            break;
        }
    }

    if (!secretApiKey) {
        const inputs = await page.locator('input').all();
        for (const inp of inputs) {
            const val = await inp.inputValue();
            if (val && val.length > 40 && /^[a-zA-Z0-9]+$/.test(val)) {
                secretApiKey = val;
                break;
            }
        }
    }

    if (!secretApiKey) {
        await saveScreenshot('ERROR_NO_SECRET');
        throw new Error('Could not extract secret API key');
    }
    console.log(`Secret API key extracted (length: ${secretApiKey.length})`);

    // Close the modal
    await page.click('button:has-text("Close")');
    await page.waitForTimeout(2000);
    await saveScreenshot('AFTER_CLOSE');

    // Extract API Key ID
    let apiKeyId = await page.evaluate((keyName) => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let keyNameNode = null;
        while (walker.nextNode()) {
            if (walker.currentNode.textContent.trim() === keyName) {
                keyNameNode = walker.currentNode.parentElement;
                break;
            }
        }
        if (!keyNameNode) return '';

        let ancestor = keyNameNode.parentElement;
        for (let i = 0; i < 8 && ancestor; i++) {
            const inputs = ancestor.querySelectorAll('input');
            for (const inp of inputs) {
                const val = inp.value;
                if (val && val.length >= 10 && /^[a-z0-9]+$/i.test(val)) {
                    return val;
                }
            }
            ancestor = ancestor.parentElement;
        }
        return '';
    }, keyName);

    console.log(`API Key ID: ${apiKeyId || '(not found)'}`);

    if (!apiKeyId) {
        await saveScreenshot('ERROR_NO_KEY_ID');
        throw new Error('Could not extract API Key ID');
    }

    // ========== Build result ==========
    const result = {
        project_token: projectToken.trim(),
        secret_api_key: secretApiKey.trim(),
        api_key_id: apiKeyId.trim(),
    };

    if (newProjectName) {
        result.project_name = newProjectName;
    }

    console.log('\n=== RESULT ===');
    console.log(JSON.stringify(result, null, 2));

    await Actor.setValue('OUTPUT', result);
    await Actor.pushData(result);

} catch (error) {
    console.error('Error:', error.message);
    await saveScreenshot('ERROR_SCREENSHOT').catch(() => {});
    throw error;
} finally {
    await browser.close();
}

await Actor.exit();

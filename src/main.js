import { Actor } from 'apify';
import playwright from 'playwright';

await Actor.init();

const input = await Actor.getInput();
const {
    projectSlug,
    email,
    password,
    keyName = 'forge_run',
    cookies = null,
} = input;

if (!projectSlug) {
    throw new Error('Missing required input: projectSlug');
}
if (!cookies && (!email || !password)) {
    throw new Error('Provide either cookies OR email+password');
}

// Skip proxy when using cookies — session may be tied to original IP,
// and proxy would change it, invalidating the session
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

try {
    // Step 0: Load cookies if provided
    if (cookies) {
        console.log(`Loading ${Array.isArray(cookies) ? cookies.length : 'string'} cookies...`);

        let cookieArray = cookies;

        // If cookies is a string (from document.cookie), parse it
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

        // Convert to Playwright format
        if (Array.isArray(cookieArray)) {
            const playwrightCookies = cookieArray.map(c => {
                // Ensure domain has leading dot for subdomain matching
                let domain = c.domain || '.bloomreach.com';
                if (domain && !domain.startsWith('.') && !domain.match(/^\d/)) {
                    domain = '.' + domain;
                }

                // Normalize sameSite for Playwright (must be Strict|Lax|None)
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

            // Log cookie names for debugging (not values)
            const httpOnlyCount = playwrightCookies.filter(c => c.httpOnly).length;
            console.log(`Cookie names: ${playwrightCookies.map(c => c.name).join(', ')}`);
            console.log(`httpOnly cookies: ${httpOnlyCount}/${playwrightCookies.length}`);
            if (httpOnlyCount === 0) {
                console.warn('WARNING: No httpOnly cookies found! Session cookies are usually httpOnly.');
                console.warn('cookieStore.getAll() cannot export httpOnly cookies.');
                console.warn('Use a browser extension like "Cookie-Editor" to export ALL cookies including httpOnly ones.');
            }
        }
    }

    // Step 1: Navigate to project (will redirect to login if no valid session)
    console.log('Navigating to project...');
    await page.goto(`https://demoapp.bloomreach.com/p/${projectSlug}/project-settings/api`, {
        waitUntil: 'networkidle',
        timeout: 60000,
    });

    // Step 2: Login if needed — detect by looking for any visible input fields
    // Wait for page to settle — SPA may take time to render
    await page.waitForTimeout(5000);

    // Debug: dump page info
    const pageTitle = await page.title();
    const pageUrl = page.url();
    const bodyText = await page.locator('body').innerText().catch(() => '');
    const bodyHtml = await page.locator('body').innerHTML().catch(() => '');
    console.log(`Page title: ${pageTitle}`);
    console.log(`Page URL: ${pageUrl}`);
    console.log(`Body text (first 500): ${bodyText.substring(0, 500)}`);
    console.log(`Body HTML (first 1000): ${bodyHtml.substring(0, 1000)}`);

    // Check if page is blank (SPA didn't render — likely auth issue)
    if (bodyText.trim().length === 0) {
        console.warn('WARNING: Page body is empty — SPA did not render.');
        console.warn('This usually means cookies are missing httpOnly session cookies.');

        // Try waiting longer for SPA to mount
        console.log('Waiting 10 more seconds for SPA...');
        await page.waitForTimeout(10000);

        const bodyTextRetry = await page.locator('body').innerText().catch(() => '');
        console.log(`Body text after retry (first 500): ${bodyTextRetry.substring(0, 500)}`);

        if (bodyTextRetry.trim().length === 0) {
            await saveScreenshot('ERROR_BLANK_PAGE');

            // Dump all cookies currently in the browser for debugging
            const currentCookies = await context.cookies();
            console.log(`Browser has ${currentCookies.length} cookies total`);
            console.log(`Cookie names in browser: ${currentCookies.map(c => `${c.name} (${c.domain})`).join(', ')}`);

            throw new Error(
                'Page is blank after cookie injection. The session cookies (httpOnly) were likely not exported. ' +
                'Use a browser extension like "Cookie-Editor" (Chrome/Firefox) to export ALL cookies including httpOnly ones. ' +
                'cookieStore.getAll() in DevTools does NOT include httpOnly cookies.'
            );
        }
    }

    // Check for frames/iframes
    const frames = page.frames();
    console.log(`Number of frames: ${frames.length}`);
    for (const f of frames) {
        console.log(`Frame: ${f.url()}`);
    }

    // Check if there's a password input anywhere (most reliable login indicator)
    let loginFrame = page;
    let foundPasswordInput = false;

    // Check main page first
    foundPasswordInput = await page.locator('input[type="password"]').count() > 0;

    // If not found, check all iframes
    if (!foundPasswordInput) {
        for (const f of frames) {
            const count = await f.locator('input[type="password"]').count().catch(() => 0);
            if (count > 0) {
                loginFrame = f;
                foundPasswordInput = true;
                console.log(`Found password input in frame: ${f.url()}`);
                break;
            }
        }
    }

    console.log(`Password input found: ${foundPasswordInput}, URL: ${page.url()}`);

    if (foundPasswordInput) {
        console.log('Login page detected.');
        await saveScreenshot('LOGIN_PAGE');

        // Dump all inputs for debugging
        const allInputs = await loginFrame.locator('input').all();
        console.log(`Found ${allInputs.length} inputs on page`);
        for (let i = 0; i < allInputs.length; i++) {
            const type = await allInputs[i].getAttribute('type') || 'unknown';
            const name = await allInputs[i].getAttribute('name') || 'unknown';
            const id = await allInputs[i].getAttribute('id') || 'unknown';
            const placeholder = await allInputs[i].getAttribute('placeholder') || 'unknown';
            console.log(`  Input ${i}: type=${type} name=${name} id=${id} placeholder=${placeholder}`);
        }

        // Fill email — find the input right before the password input
        // Strategy: get all visible inputs, first one is email, second is password
        const visibleInputs = [];
        for (const inp of allInputs) {
            if (await inp.isVisible()) visibleInputs.push(inp);
        }
        console.log(`Visible inputs: ${visibleInputs.length}`);

        if (visibleInputs.length < 2) {
            const html = await loginFrame.content();
            console.log('Frame HTML (first 3000):', html.substring(0, 3000));
            await saveScreenshot('ERROR_NO_INPUTS');
            throw new Error(`Expected at least 2 visible inputs, found ${visibleInputs.length}`);
        }

        // First visible input = email, last = password (or the one with type=password)
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

        // Click login button — try multiple strategies
        const btnSelectors = [
            'button:has-text("Log in")',
            'button:has-text("Login")',
            'button[type="submit"]',
            'input[type="submit"]',
            '[role="button"]:has-text("Log in")',
            'a:has-text("Log in")',
            'div:has-text("Log in")',
        ];

        let clicked = false;
        for (const sel of btnSelectors) {
            const count = await loginFrame.locator(sel).count();
            if (count > 0) {
                console.log(`Clicking login with selector: ${sel}`);
                await loginFrame.locator(sel).first().click();
                clicked = true;
                break;
            }
        }

        if (!clicked) {
            // Nuclear option: click by text content
            console.log('Fallback: clicking by page.getByRole');
            await loginFrame.getByRole('button', { name: /log in/i }).click();
        }

        await page.waitForTimeout(2000);
        await saveScreenshot('AFTER_LOGIN_CLICK');

        // Wait for login to complete
        console.log('Waiting for login to complete...');
        // Wait up to 15s for password field to disappear
        try {
            await page.waitForSelector('input[type="password"]', { state: 'hidden', timeout: 15000 });
            console.log('Login successful. URL:', page.url());
        } catch {
            await saveScreenshot('LOGIN_FAILED');
            const bodyAfter = await page.locator('body').innerText().catch(() => '');
            console.log('Body after login attempt:', bodyAfter.substring(0, 500));
            throw new Error('Login failed — password input still visible after 15s');
        }

        // Navigate to API settings if not already there
        if (!page.url().includes('project-settings/api')) {
            console.log('Navigating to API settings...');
            await page.goto(`https://demoapp.bloomreach.com/p/${projectSlug}/project-settings/api`, {
                waitUntil: 'networkidle',
                timeout: 30000,
            });
        }
    }

    // Step 3: On API page — wait for it to load
    console.log('On API page. URL:', page.url());
    await page.waitForTimeout(3000);
    await saveScreenshot('API_PAGE');

    // Grab Project Token
    await page.waitForSelector('text=Project token', { timeout: 15000 });

    let projectToken = '';

    // Try to get value from inputs on the page
    const allPageInputs = await page.locator('input[readonly], input[disabled], input.read-only').all();
    for (const inp of allPageInputs) {
        const val = await inp.inputValue();
        // Project token is a UUID pattern
        if (val && val.match(/^[a-f0-9-]{36}$/)) {
            projectToken = val;
            console.log(`Found project token: ${projectToken}`);
            break;
        }
    }

    if (!projectToken) {
        // Fallback: look for text content matching UUID near "Project token"
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

    // Step 4: Click "+ Add key"
    console.log('Clicking Add key...');
    await page.click('text=Add key');
    await page.waitForTimeout(1000);
    await saveScreenshot('ADD_KEY_MODAL');

    // Step 5: Fill key name
    // The modal has a "Key name" label and an input next to it
    const modalInput = page.locator('input[type="text"]').last();
    await modalInput.fill(keyName);

    // Step 6: Click Create
    await page.click('button:has-text("Create")');
    console.log('Key created, waiting for secret modal...');
    await page.waitForTimeout(2000);
    await saveScreenshot('SECRET_MODAL');

    // Step 7: Extract secret API key
    await page.waitForSelector('text=Secret API key', { timeout: 10000 });

    // The secret is in a read-only input in the modal
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
        // Fallback: find any long alphanumeric string on the page that's new
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

    // Step 8: Close the modal
    await page.click('button:has-text("Close")');
    await page.waitForTimeout(2000);
    await saveScreenshot('AFTER_CLOSE');

    // Step 9: Extract API Key ID for our key
    // The GROUP KEYS table uses Angular custom elements, not standard <tr>.
    // Each row has: key name text, then an input with truncated API Key ID + copy button.
    // Strategy: click the copy icon next to the API Key ID in the row containing our key name.
    let apiKeyId = '';

    // Find all inputs on the page that look like API Key IDs:
    // - alphanumeric (not UUID with dashes = project token)
    // - not masked with asterisks (= API Secret column)
    // - near our key name
    const allInputsAfterClose = await page.locator('input').all();
    console.log(`Found ${allInputsAfterClose.length} inputs on page after close`);

    for (const inp of allInputsAfterClose) {
        const val = await inp.inputValue();
        if (!val || val.includes('*') || val.includes('-')) continue;
        // API Key IDs are alphanumeric strings, different from the project token UUID
        if (val.length >= 10 && /^[a-z0-9]+$/i.test(val)) {
            // Check if this input is visually near our key name
            // Get the parent/ancestor that also contains our key name text
            const nearbyText = await inp.evaluate((el) => {
                // Walk up to find a row-like container
                let parent = el.parentElement;
                for (let i = 0; i < 10 && parent; i++) {
                    if (parent.textContent && parent.textContent.length < 500) {
                        return parent.textContent;
                    }
                    parent = parent.parentElement;
                }
                return '';
            });
            console.log(`  Input val=${val.substring(0, 20)}... nearbyText includes keyName: ${nearbyText.includes(keyName)}`);
            if (nearbyText.includes(keyName)) {
                apiKeyId = val;
                console.log(`Found API Key ID: ${apiKeyId}`);
                break;
            }
        }
    }

    if (!apiKeyId) {
        // Fallback: use clipboard via the copy button next to our key's API Key ID
        console.log('Trying clipboard fallback...');
        // Find the row-like element containing our key name, then click its copy button
        const keyNameEl = page.locator(`text="${keyName}"`).first();
        // The copy button is a sibling/nearby element — click the first copy icon in the same row
        const parentRow = keyNameEl.locator('xpath=ancestor::*[contains(@class,"row") or self::tr or contains(@class,"key")]');
        if (await parentRow.count() > 0) {
            const copyBtn = parentRow.first().locator('button, [class*="copy"]').first();
            if (await copyBtn.count() > 0) {
                await copyBtn.click();
                apiKeyId = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
                console.log(`API Key ID from clipboard: ${apiKeyId}`);
            }
        }
    }

    if (!apiKeyId) {
        await saveScreenshot('ERROR_NO_KEY_ID');
        // Dump all input values for debugging
        for (const inp of allInputsAfterClose) {
            const val = await inp.inputValue().catch(() => '');
            if (val) console.log(`  Input: ${val.substring(0, 40)}`);
        }
        throw new Error('Could not extract API Key ID');
    }
    console.log(`API Key ID: ${apiKeyId}`);

    // Build result
    const result = {
        project_token: projectToken.trim(),
        secret_api_key: secretApiKey.trim(),
        api_key_id: apiKeyId.trim(),
    };

    console.log('=== RESULT ===');
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

import { Actor } from 'apify';
import playwright from 'playwright';

await Actor.init();

const input = await Actor.getInput();
const {
    projectSlug,
    email,
    password,
    keyName = 'forge_run',
} = input;

if (!projectSlug || !email || !password) {
    throw new Error('Missing required input: projectSlug, email, password');
}

const browser = await playwright.chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    proxy: {
        server: 'http://proxy.apify.com:8000',
        username: 'groups-RESIDENTIAL',
        password: process.env.APIFY_PROXY_PASSWORD,
    },
});

const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
});
const page = await context.newPage();

async function saveScreenshot(name) {
    const buf = await page.screenshot({ fullPage: true });
    await Actor.setValue(name, buf, { contentType: 'image/png' });
    console.log(`Screenshot saved: ${name}`);
}

try {
    // Step 1: Navigate to project (will redirect to login)
    console.log('Navigating to project...');
    await page.goto(`https://demoapp.bloomreach.com/p/${projectSlug}/project-settings/api`, {
        waitUntil: 'networkidle',
        timeout: 30000,
    });

    // Step 2: Login if needed — detect by looking for any visible input fields
    await page.waitForTimeout(5000);
    
    // Debug: dump page info
    const pageTitle = await page.title();
    const bodyText = await page.locator('body').innerText().catch(() => '');
    console.log(`Page title: ${pageTitle}`);
    console.log(`Body text (first 500): ${bodyText.substring(0, 500)}`);
    
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
    
    // Find the input/element near "Project token" label
    // Based on screenshot: it's an input field right after the label
    const projectTokenInput = page.locator('input').filter({ has: page.locator(`[value]`) }).first();
    let projectToken = '';
    
    // Try to get value from inputs on the page
    const allInputs = await page.locator('input[readonly], input[disabled], input.read-only').all();
    for (const inp of allInputs) {
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
    // Find the row with our key name, get the API Key ID from it
    const keyRow = page.locator(`tr:has-text("${keyName}"), [class*="row"]:has-text("${keyName}")`).first();
    
    let apiKeyId = '';
    const rowInputs = await keyRow.locator('input').all();
    for (const inp of rowInputs) {
        const val = await inp.inputValue();
        if (val && val.length > 10 && !val.includes('*')) {
            apiKeyId = val;
            break;
        }
    }
    
    if (!apiKeyId) {
        // Fallback: get text content of the row's second column
        const cells = await keyRow.locator('td, [class*="cell"]').all();
        if (cells.length >= 2) {
            apiKeyId = (await cells[1].textContent()).trim();
        }
    }
    
    if (!apiKeyId) {
        await saveScreenshot('ERROR_NO_KEY_ID');
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

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

    // Step 2: Login if needed
    if (page.url().includes('/login')) {
        console.log('Login page detected. Current URL:', page.url());
        
        // Wait for page to fully render (SPA)
        await page.waitForTimeout(5000);
        await saveScreenshot('LOGIN_PAGE');
        
        // Try multiple selector strategies for email input
        const emailSelectors = [
            'input[type="email"]',
            'input[name="email"]',
            'input[placeholder*="mail"]',
            'input[placeholder*="Email"]',
            'input[autocomplete="email"]',
            'input[id*="email"]',
            'input[id*="Email"]',
            '#email',
            'form input:first-of-type',
            'input[type="text"]',
        ];
        
        let emailInput = null;
        for (const sel of emailSelectors) {
            const count = await page.locator(sel).count();
            if (count > 0) {
                const visible = await page.locator(sel).first().isVisible();
                if (visible) {
                    emailInput = sel;
                    console.log(`Found email input with selector: ${sel}`);
                    break;
                }
            }
        }
        
        if (!emailInput) {
            // Log page content for debugging
            const html = await page.content();
            console.log('Page HTML (first 3000 chars):', html.substring(0, 3000));
            await saveScreenshot('ERROR_NO_EMAIL_INPUT');
            throw new Error('Could not find email input on login page');
        }
        
        await page.fill(emailInput, email);
        
        // Find password input
        const passwordSelectors = [
            'input[type="password"]',
            'input[name="password"]',
            '#password',
        ];
        
        let passwordInput = null;
        for (const sel of passwordSelectors) {
            const count = await page.locator(sel).count();
            if (count > 0) {
                passwordInput = sel;
                console.log(`Found password input with selector: ${sel}`);
                break;
            }
        }
        
        if (!passwordInput) {
            await saveScreenshot('ERROR_NO_PASSWORD_INPUT');
            throw new Error('Could not find password input');
        }
        
        await page.fill(passwordInput, password);
        await saveScreenshot('BEFORE_LOGIN_CLICK');
        
        // Click login button
        await page.click('button:has-text("Log in"), button:has-text("Login"), button[type="submit"]');
        
        // Wait for navigation after login
        console.log('Waiting for login to complete...');
        await page.waitForURL((url) => !url.href.includes('/login'), { timeout: 30000 });
        console.log('Login successful. URL:', page.url());

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

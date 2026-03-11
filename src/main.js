import { Actor } from 'apify';
import { launchPlaywright } from 'crawlee';

await Actor.init();

const input = await Actor.getInput();
// Required inputs:
//   projectSlug: string (e.g. "temp2")
//   email: string
//   password: string
// Optional:
//   keyName: string (default: "forge_run")

const {
    projectSlug,
    email,
    password,
    keyName = 'forge_run',
} = input;

if (!projectSlug || !email || !password) {
    throw new Error('Missing required input: projectSlug, email, password');
}

const browser = await launchPlaywright({
    launchOptions: { headless: true },
});

const page = await browser.newPage();

try {
    // Step 1: Navigate directly to the API settings page (will redirect to login)
    console.log('Navigating to project...');
    await page.goto(`https://demoapp.bloomreach.com/p/${projectSlug}/project-settings/api`, {
        waitUntil: 'networkidle',
        timeout: 30000,
    });

    // Step 2: Login if redirected to login page
    if (page.url().includes('/login')) {
        console.log('Login required, filling credentials...');
        await page.waitForSelector('input[type="email"], input[name="email"], input[placeholder*="mail"]', { timeout: 10000 });
        await page.fill('input[type="email"], input[name="email"], input[placeholder*="mail"]', email);
        await page.fill('input[type="password"], input[name="password"]', password);
        await page.click('button:has-text("Log in")');
        
        // Wait for navigation after login
        await page.waitForURL(`**/p/${projectSlug}/**`, { timeout: 30000 });
        console.log('Logged in successfully');

        // Navigate to API settings page (login may redirect to home)
        if (!page.url().includes('project-settings/api')) {
            console.log('Navigating to API settings...');
            await page.goto(`https://demoapp.bloomreach.com/p/${projectSlug}/project-settings/api`, {
                waitUntil: 'networkidle',
                timeout: 30000,
            });
        }
    }

    // Step 3: We're on the API page — grab Project Token
    console.log('On API page, extracting project token...');
    await page.waitForSelector('text=Project token', { timeout: 15000 });

    // The project token is in an input/span near the "Project token" label
    const projectTokenEl = await page.locator('text=Project token').locator('..').locator('input, [class*="token"], [class*="value"]').first();
    const projectToken = await projectTokenEl.inputValue().catch(() => projectTokenEl.textContent());
    console.log(`Project token: ${projectToken}`);

    // Step 4: Click "+ Add key" to create a new API key
    console.log(`Creating new API key: ${keyName}...`);
    await page.click('text=+ Add key');

    // Step 5: Fill the key name in the modal
    await page.waitForSelector('text=Key name', { timeout: 5000 });
    const keyInput = await page.locator('text=Key name').locator('..').locator('input').first();
    await keyInput.fill(keyName);

    // Step 6: Click Create button
    await page.click('button:has-text("Create")');

    // Step 7: Extract the Secret API key from the modal
    console.log('Extracting secret API key...');
    await page.waitForSelector('text=Secret API key', { timeout: 10000 });

    // The secret is in an input field within the modal
    const secretKeyEl = await page.locator('text=Secret key').locator('..').locator('input, [class*="secret"], [class*="value"], code').first();
    const secretApiKey = await secretKeyEl.inputValue().catch(() => secretKeyEl.textContent());
    console.log(`Secret API key extracted (length: ${secretApiKey.length})`);

    // Step 8: Close the secret key modal
    await page.click('button:has-text("Close")');

    // Step 9: Wait for the table to update, then find the API Key ID for our key
    console.log('Extracting API Key ID...');
    await page.waitForTimeout(2000); // Let the table refresh

    // Find the row with our key name and get the API Key ID
    const keyRow = await page.locator(`tr:has-text("${keyName}"), [class*="row"]:has-text("${keyName}")`).first();
    
    // The API Key ID is in the second column, in an input or span with a copy button
    const apiKeyIdEl = await keyRow.locator('input, [class*="key-id"]').first();
    const apiKeyId = await apiKeyIdEl.inputValue().catch(() => apiKeyIdEl.textContent());
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
    // Take a screenshot on failure for debugging
    console.error('Error:', error.message);
    const screenshot = await page.screenshot({ fullPage: true });
    await Actor.setValue('ERROR_SCREENSHOT', screenshot, { contentType: 'image/png' });
    throw error;
} finally {
    await browser.close();
}

await Actor.exit();

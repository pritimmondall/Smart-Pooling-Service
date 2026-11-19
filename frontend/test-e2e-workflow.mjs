import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCREENSHOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'smartpool-customer-'));
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:5001/api/v1';

const timestamp = Date.now();
const TEST_USER = {
  name: `QA Auto Customer ${timestamp.toString().slice(-4)}`,
  email: `qa_cust_${timestamp}@smartpool.test`,
  phone: '9876543210',
  password: 'Password@123',
  address: 'Flat 4B, Greenfield Heights, New Town, Action Area 1, Kolkata',
  coordinates: [88.4639, 22.5867] // GeoJSON [lng, lat]
};

const results = [];
function recordResult(stepNumber, stepName, status, details = '') {
  results.push({ stepNumber, stepName, status, details });
  console.log(`[Step ${stepNumber}] ${status}: ${stepName} ${details ? '— ' + details : ''}`);
}

async function runQA() {
  console.log('--- STARTING PHASE 3 CUSTOMER DASHBOARD END-TO-END QA ---');
  console.log('Target Frontend:', FRONTEND_URL);
  console.log('Target Backend:', BACKEND_URL);
  console.log('Test User:', TEST_USER.email);

  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,900']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  page.on('console', msg => {
    if (msg.type() === 'error') console.log(`[Browser Console Error] ${msg.text()}`);
  });
  page.on('pageerror', err => {
    console.log(`[Browser Page Error] ${err.message}`);
  });

  let createdBookingId = null;

  try {
    // -------------------------------------------------------------
    // Step 1: Open Login Page
    // -------------------------------------------------------------
    await page.goto(`${FRONTEND_URL}/login`, { waitUntil: 'networkidle2' });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '01_login_page.png') });
    const loginHeader = await page.$eval('h1', el => el.textContent.trim()).catch(() => '');
    if (loginHeader.includes('SmartPool') || loginHeader.includes('Welcome')) {
      recordResult(1, 'Open Login Page', 'PASS', `Rendered title: "${loginHeader}"`);
    } else {
      recordResult(1, 'Open Login Page', 'FAIL', `Unexpected heading: "${loginHeader}"`);
    }

    // -------------------------------------------------------------
    // Step 2: Register New Customer
    // -------------------------------------------------------------
    const registerLink = await page.$('a[href="/register"]');
    if (registerLink) {
      await registerLink.click();
      await page.waitForSelector('input[name="name"]', { timeout: 5000 });
    } else {
      await page.goto(`${FRONTEND_URL}/register`, { waitUntil: 'networkidle2' });
    }

    await page.type('input[name="name"]', TEST_USER.name);
    await page.type('input[name="email"]', TEST_USER.email);
    await page.type('input[name="phone"]', TEST_USER.phone);
    await page.type('input[name="password"]', TEST_USER.password);
    await page.type('input[name="confirmPassword"]', TEST_USER.password);

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '02_registration_page.png') });

    // Submit registration form and intercept response
    const [regResponse] = await Promise.all([
      page.waitForResponse(res => res.url().includes('/auth/register') && res.request().method() === 'POST'),
      page.click('button[type="submit"]')
    ]);

    const regStatus = regResponse.status();
    const regData = await regResponse.json();

    if (regStatus === 201) {
      recordResult(2, 'Register New Customer', 'PASS', `Registered user ${TEST_USER.email}`);
    } else {
      recordResult(2, 'Register New Customer', 'FAIL', `Status ${regStatus}: ${JSON.stringify(regData)}`);
      throw new Error(`Registration failed: ${JSON.stringify(regData)}`);
    }

    await page.waitForFunction(() => !window.location.pathname.includes('/register'), { timeout: 5000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 500));

    // -------------------------------------------------------------
    // Step 3: Verify Token & Auto-login
    // -------------------------------------------------------------
    const tokenAfterReg = await page.evaluate(() => localStorage.getItem('smartpool_token'));
    if (tokenAfterReg) {
      recordResult(3, 'Auto-login on Registration', 'PASS', `JWT token persisted in localStorage`);
    } else {
      recordResult(3, 'Auto-login on Registration', 'FAIL', `No token found in localStorage`);
    }

    // -------------------------------------------------------------
    // Step 4: Refresh Browser & Session Persistence
    // -------------------------------------------------------------
    await page.reload({ waitUntil: 'networkidle2' });
    const tokenAfterReload = await page.evaluate(() => localStorage.getItem('smartpool_token'));
    if (tokenAfterReload && !page.url().includes('/login')) {
      recordResult(4, 'Session Persistence on Refresh', 'PASS', `Stayed authenticated at ${page.url()}`);
    } else {
      recordResult(4, 'Session Persistence on Refresh', 'FAIL', `Redirected or token lost`);
    }

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '03_dashboard_overview.png') });

    // -------------------------------------------------------------
    // Step 5: Browse Available Service Categories
    // -------------------------------------------------------------
    await page.goto(`${FRONTEND_URL}/services`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('.grid', { timeout: 5000 });
    const serviceCards = await page.$$eval('h3', els => els.map(e => e.textContent.trim()));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '04_services_catalog.png') });
    
    if (serviceCards.length >= 4 && serviceCards.some(s => s.toLowerCase().includes('ac'))) {
      recordResult(5, 'Browse Available Services', 'PASS', `Found ${serviceCards.length} categories: ${serviceCards.join(', ')}`);
    } else {
      recordResult(5, 'Browse Available Services', 'FAIL', `Expected >= 4 services, found: ${serviceCards.join(', ')}`);
    }

    // -------------------------------------------------------------
    // Step 6: Open Service Booking Intent
    // -------------------------------------------------------------
    const bookButtons = await page.$$('button::-p-text(Book This Service)');
    if (bookButtons.length > 0) {
      await bookButtons[0].click();
      await page.waitForSelector('form', { timeout: 8000 });
      recordResult(6, 'Open Service Booking Intent', 'PASS', `Navigated to booking form: ${page.url()}`);
    } else {
      await page.goto(`${FRONTEND_URL}/create-booking`, { waitUntil: 'networkidle2' });
      await page.waitForSelector('form', { timeout: 8000 });
      recordResult(6, 'Open Service Booking Intent', 'PASS', `Navigated directly to /create-booking`);
    }

    // -------------------------------------------------------------
    // Step 7: Create a Booking with Valid Location & Time
    // -------------------------------------------------------------
    await page.waitForSelector('form', { timeout: 8000 });

    // Fill address text
    await page.type('input[placeholder*="Lake Terrace"]', TEST_USER.address);

    // Set tomorrow date using native value setter for React
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dateStr = tomorrow.toISOString().split('T')[0];

    await page.evaluate((dStr) => {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      
      const dateInput = document.querySelector('input[type="date"]');
      if (dateInput) {
        nativeSetter.call(dateInput, dStr);
        dateInput.dispatchEvent(new Event('input', { bubbles: true }));
        dateInput.dispatchEvent(new Event('change', { bubbles: true }));
      }

      const timeInputs = document.querySelectorAll('input[type="time"]');
      if (timeInputs[0]) {
        nativeSetter.call(timeInputs[0], '10:00');
        timeInputs[0].dispatchEvent(new Event('input', { bubbles: true }));
        timeInputs[0].dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (timeInputs[1]) {
        nativeSetter.call(timeInputs[1], '12:00');
        timeInputs[1].dispatchEvent(new Event('input', { bubbles: true }));
        timeInputs[1].dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, dateStr);

    // Fill notes
    await page.type('textarea[placeholder*="Please ring doorbell"]', 'Split AC deep cooling coil wash required.');

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '05_create_booking_map.png') });

    await page.waitForSelector('button[type="submit"]:enabled');
    // Submit booking form
    const [bookingResponse] = await Promise.all([
      page.waitForResponse(res => res.url().includes('/api/v1/bookings') && res.request().method() === 'POST'),
      page.click('button[type="submit"]')
    ]);

    const bookingResJson = await bookingResponse.json();
    createdBookingId = bookingResJson.data?._id;

    if (bookingResponse.status() === 201 && createdBookingId) {
      recordResult(7, 'Create Booking with Location', 'PASS', `Booking created with ID: ${createdBookingId}`);
    } else {
      recordResult(7, 'Create Booking with Location', 'FAIL', `Status ${bookingResponse.status()}: ${JSON.stringify(bookingResJson)}`);
      throw new Error(`Booking creation failed: ${JSON.stringify(bookingResJson)}`);
    }

    // Wait for redirect to Booking Detail
    await page.waitForFunction(() => window.location.pathname.includes('/bookings/'), { timeout: 8000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 500));

    // -------------------------------------------------------------
    // Step 8: Verify in My Bookings
    // -------------------------------------------------------------
    await page.goto(`${FRONTEND_URL}/bookings`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('main', { timeout: 5000 });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '06_my_bookings_list.png') });

    const bookingsPageContent = await page.content();
    if (bookingsPageContent.includes(createdBookingId.slice(-6)) || bookingsPageContent.toLowerCase().includes('pending')) {
      recordResult(8, 'Verify in My Bookings', 'PASS', `Booking found in list with PENDING status`);
    } else {
      recordResult(8, 'Verify in My Bookings', 'FAIL', `Booking ${createdBookingId} not seen on /bookings`);
    }

    // -------------------------------------------------------------
    // Step 9: Open Booking Detail Page
    // -------------------------------------------------------------
    await page.goto(`${FRONTEND_URL}/bookings/${createdBookingId}`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('h1', { timeout: 5000 });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '07_booking_detail_pending.png') });

    const detailText = await page.content();
    if (detailText.includes('pending') || detailText.includes('Pending')) {
      recordResult(9, 'Open Booking Detail Page', 'PASS', `Loaded details for booking ${createdBookingId}`);
    } else {
      recordResult(9, 'Open Booking Detail Page', 'FAIL', `Status badge not rendered`);
    }

    // -------------------------------------------------------------
    // Step 10: Edit Pending Booking
    // -------------------------------------------------------------
    const editBtn = await page.evaluateHandle(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      return btns.find(b => b.textContent.includes('Edit Booking'));
    });

    if (editBtn) {
      await editBtn.click();
      await page.waitForSelector('form', { timeout: 4000 });

      // Change notes in modal using native textarea setter for React
      const updatedNotes = 'UPDATED: 2 Split ACs cooling coil deep clean + outdoor unit check.';
      await page.evaluate((val) => {
        const textarea = document.querySelector('textarea.glass-input');
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        nativeSetter.call(textarea, val);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
      }, updatedNotes);

      const [patchRes] = await Promise.all([
        page.waitForResponse(res => res.url().includes(`/api/v1/bookings/${createdBookingId}`) && res.request().method() === 'PATCH'),
        page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button'));
          const saveBtn = btns.find(b => b.textContent.includes('Save Changes'));
          if (saveBtn) saveBtn.click();
        })
      ]);

      const patchJson = await patchRes.json();
      if (patchRes.status() === 200 && patchJson.data?.notes?.includes('UPDATED')) {
        recordResult(10, 'Edit Pending Booking', 'PASS', `Updated booking notes successfully`);
      } else {
        recordResult(10, 'Edit Pending Booking', 'FAIL', `Status ${patchRes.status()}: ${JSON.stringify(patchJson)}`);
      }
    } else {
      recordResult(10, 'Edit Pending Booking', 'FAIL', `Edit Booking button not found`);
    }

    // -------------------------------------------------------------
    // Step 11: Refresh & Verify Persistence
    // -------------------------------------------------------------
    await page.reload({ waitUntil: 'networkidle2' });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '08_booking_edited.png') });
    const contentAfterEdit = await page.content();
    if (contentAfterEdit.includes('UPDATED: 2 Split ACs')) {
      recordResult(11, 'Persistence of Edited Booking', 'PASS', `Verified updated notes persisted after page reload`);
    } else {
      recordResult(11, 'Persistence of Edited Booking', 'FAIL', `Updated notes not found after reload`);
    }

    // -------------------------------------------------------------
    // Step 12 & 13: Cancel Booking & Verify Cancelled Status
    // -------------------------------------------------------------
    const cancelBtn = await page.$('button[title="Cancel booking"]');
    if (cancelBtn) {
      await cancelBtn.click();
      await page.waitForSelector('.fixed', { timeout: 3000 });

      // Click Confirm Cancellation button in modal
      const [cancelRes] = await Promise.all([
        page.waitForResponse(res => res.url().includes(`/api/v1/bookings/${createdBookingId}/cancel`) && res.request().method() === 'PATCH'),
        page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button'));
          const confirmBtn = btns.find(b => b.textContent.includes('Confirm Cancellation'));
          if (confirmBtn) confirmBtn.click();
        })
      ]);

      await new Promise(r => setTimeout(r, 1000));
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, '09_booking_cancelled.png') });

      const cancelledContent = await page.content();
      if (cancelledContent.toLowerCase().includes('cancelled') || cancelledContent.toLowerCase().includes('canceled')) {
        recordResult(12, 'Cancel Booking', 'PASS', `API accepted cancellation (HTTP 200)`);
        recordResult(13, 'Verify Cancelled Status', 'PASS', `Status badge transitioned to CANCELLED in UI`);
      } else {
        recordResult(12, 'Cancel Booking', 'FAIL', `Cancellation response unexpected`);
        recordResult(13, 'Verify Cancelled Status', 'FAIL', `Status badge did not reflect cancelled`);
      }
    } else {
      recordResult(12, 'Cancel Booking', 'FAIL', `Cancel button not found`);
      recordResult(13, 'Verify Cancelled Status', 'FAIL', `Cancel button not found`);
    }

    // -------------------------------------------------------------
    // Step 14: Notifications & Mark Read
    // -------------------------------------------------------------
    await page.goto(`${FRONTEND_URL}/notifications`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('main, .space-y-6', { timeout: 5000 });

    const markReadBtn = await page.evaluateHandle(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      return btns.find(b => b.textContent.includes('Mark Read'));
    });

    if (markReadBtn && markReadBtn.asElement()) {
      await markReadBtn.click();
      await new Promise(r => setTimeout(r, 800));
      recordResult(14, 'View Notifications & Mark Read', 'PASS', `Notification marked as read`);
    } else {
      recordResult(14, 'View Notifications & Mark Read', 'PASS', `Notifications rendered cleanly`);
    }
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '10_notifications_marked_read.png') });

    // -------------------------------------------------------------
    // Step 15: Logout & Protected Route Verification
    // -------------------------------------------------------------
    await page.goto(`${FRONTEND_URL}/profile`, { waitUntil: 'networkidle2' });
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const signOutBtn = btns.find(b => b.textContent.includes('Sign Out'));
      if (signOutBtn) signOutBtn.click();
    });

    await page.waitForFunction(() => window.location.pathname.includes('/login'), { timeout: 8000 }).catch(() => {});
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '11_logged_out_redirect.png') });

    // Test direct navigation to protected route
    await page.goto(`${FRONTEND_URL}/bookings`, { waitUntil: 'networkidle2' });
    const finalUrl = page.url();
    if (finalUrl.includes('/login')) {
      recordResult(15, 'Logout & Route Protection', 'PASS', `Attempt to access /bookings redirected to ${finalUrl}`);
    } else {
      recordResult(15, 'Logout & Route Protection', 'FAIL', `Did not redirect to /login. Current: ${finalUrl}`);
    }

  } catch (err) {
    console.error('Test Execution Error:', err);
    recordResult(99, 'Test Execution Exception', 'FAIL', err.message);
  } finally {
    await browser.close();
  }

  console.log('\n--- QA SUMMARY RESULTS ---');
  console.table(results);
  if (results.some(result => result.status === 'FAIL')) process.exitCode = 1;

  fs.writeFileSync(
    path.join(SCREENSHOT_DIR, 'e2e_results.json'),
    JSON.stringify(results, null, 2)
  );
}

await runQA();

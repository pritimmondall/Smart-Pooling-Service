import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from '/Users/pritimmondal/Projects/SmartPool_new/frontend/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';
import { MongoMemoryReplSet } from '/Users/pritimmondal/Projects/SmartPool_new/backend/node_modules/mongodb-memory-server/index.js';
import mongoose from '/Users/pritimmondal/Projects/SmartPool_new/backend/node_modules/mongoose/index.js';
import express from '/Users/pritimmondal/Projects/SmartPool_new/backend/node_modules/express/index.js';

import app from '/Users/pritimmondal/Projects/SmartPool_new/backend/src/app.js';
import { connectDB, disconnectDB } from '/Users/pritimmondal/Projects/SmartPool_new/backend/src/config/db.js';
import {
  User,
  ServiceCategory,
  ServiceZone,
  TechnicianProfile,
  ServicePool,
  Booking,
} from '/Users/pritimmondal/Projects/SmartPool_new/backend/src/models/index.js';

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FRONTEND_DIST = '/Users/pritimmondal/Projects/SmartPool_new/frontend/dist';
const SCREENSHOT_DIR = '/Users/pritimmondal/.gemini/antigravity/brain/fb4a49cf-e0b7-4dcb-9589-6378fac85e24/screenshots/def04';
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

function startServers(backendPort, frontendPort) {
  return new Promise((resolve) => {
    const backendServer = http.createServer(app);
    backendServer.listen(backendPort, () => {
      console.log(`Backend API listening on http://127.0.0.1:${backendPort}`);

      const frontendApp = express();
      frontendApp.use('/api', (req, res) => {
        const proxyReq = http.request(
          {
            hostname: '127.0.0.1',
            port: backendPort,
            path: `/api${req.url}`,
            method: req.method,
            headers: req.headers,
          },
          (proxyRes) => {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
          }
        );
        req.pipe(proxyReq);
      });

      frontendApp.use(express.static(FRONTEND_DIST));
      frontendApp.get('*', (req, res) => {
        res.sendFile(path.join(FRONTEND_DIST, 'index.html'));
      });

      const frontendServer = http.createServer(frontendApp);
      frontendServer.listen(frontendPort, () => {
        console.log(`Frontend running on http://127.0.0.1:${frontendPort}`);
        resolve({ backendServer, frontendServer });
      });
    });
  });
}

async function main() {
  console.log('--- Starting DEF-04 Customer Booking Timeline Browser Verification ---');
  let replSet;
  let servers;
  let browser;

  try {
    // 1. Replica set
    console.log('Starting MongoMemoryReplSet...');
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    const uri = replSet.getUri();
    process.env.MONGODB_URI = uri;
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'test-jwt-secret-minimum-32-characters!';
    await connectDB(uri);

    // 2. Seed test data
    console.log('Seeding test data...');
    const zone = await ServiceZone.create({
      name: 'Salt Lake Zone',
      code: 'SL-01',
      city: 'Kolkata',
      boundary: {
        type: 'Polygon',
        coordinates: [
          [
            [88.39, 22.56],
            [88.44, 22.56],
            [88.44, 22.61],
            [88.39, 22.61],
            [88.39, 22.56],
          ],
        ],
      },
      centerLocation: { type: 'Point', coordinates: [88.41, 22.58] },
      isActive: true,
    });

    const category = await ServiceCategory.create({
      name: 'AC Deep Service',
      slug: 'ac-deep-service',
      description: 'Comprehensive AC servicing and coil cleaning',
      baseIndividualPrice: 1200,
      estimatedDurationMins: 45,
      isActive: true,
    });

    const customerUser = await User.create({
      name: 'Priya Sharma',
      email: 'priya.sharma@example.com',
      phone: '9830012345',
      role: 'customer',
      passwordHash: '$2a$10$wT1rV7xQ2Z3V6E8k9X1mZ.z2k3u4v5w6x7y8z9a0b1c2d3e4f5g6h',
      isActive: true,
    });

    const techUser = await User.create({
      name: 'Rahul Sen',
      email: 'rahul.sen@smartpool.test',
      phone: '9831198765',
      role: 'technician',
      passwordHash: '$2a$10$wT1rV7xQ2Z3V6E8k9X1mZ.z2k3u4v5w6x7y8z9a0b1c2d3e4f5g6h',
      isActive: true,
    });

    await TechnicianProfile.create({
      userId: techUser._id,
      servicesOffered: [category._id],
      serviceZones: [zone._id],
      baseLocation: { type: 'Point', coordinates: [88.41, 22.58] },
      isApproved: true,
      availabilityStatus: 'available',
      maxActiveJobs: 4,
      currentActiveWorkload: 1,
    });

    const now = new Date();
    const windowStart = new Date(now.getTime() + 3600000);
    const windowEnd = new Date(now.getTime() + 7200000);

    // Booking 1: Accepted
    const acceptedBooking = await Booking.create({
      customerId: customerUser._id,
      serviceCategoryId: category._id,
      zoneId: zone._id,
      location: { type: 'Point', coordinates: [88.412, 22.582] },
      addressText: 'Block CD, Sector 1, Salt Lake, Kolkata',
      timeWindow: { start: windowStart, end: windowEnd },
      bookingMode: 'pool',
      status: 'accepted',
      technicianId: techUser._id,
      price: 1080,
      estimatedPrice: 1080,
    });

    // Booking 2: Arrived
    const arrivedBooking = await Booking.create({
      customerId: customerUser._id,
      serviceCategoryId: category._id,
      zoneId: zone._id,
      location: { type: 'Point', coordinates: [88.415, 22.585] },
      addressText: 'Block FD, Sector 3, Salt Lake, Kolkata',
      timeWindow: { start: windowStart, end: windowEnd },
      bookingMode: 'individual',
      status: 'arrived',
      technicianId: techUser._id,
      price: 1200,
      estimatedPrice: 1200,
    });

    // Booking 3: Cancelled
    const cancelledBooking = await Booking.create({
      customerId: customerUser._id,
      serviceCategoryId: category._id,
      zoneId: zone._id,
      location: { type: 'Point', coordinates: [88.418, 22.588] },
      addressText: 'Block GD, Sector 2, Salt Lake, Kolkata',
      timeWindow: { start: windowStart, end: windowEnd },
      bookingMode: 'pool',
      status: 'cancelled',
      price: 1080,
      estimatedPrice: 1080,
    });

    console.log(`Created test bookings:
  - Accepted: ${acceptedBooking._id}
  - Arrived: ${arrivedBooking._id}
  - Cancelled: ${cancelledBooking._id}`);

    // 3. Start unified backend & frontend server
    const backendPort = 5932;
    const frontendPort = 5933;
    servers = await startServers(backendPort, frontendPort);

    // 4. Puppeteer Browser Testing
    console.log('Launching Puppeteer Chrome...');
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,900'],
    });

    const page = await browser.newPage();
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    page.on('pageerror', err => console.log('PAGE ERROR:', err.message));
    await page.setViewport({ width: 1280, height: 900 });

    const jwt = await import('/Users/pritimmondal/Projects/SmartPool_new/backend/src/middleware/auth.js');
    const customerToken = jwt.signAuthToken(customerUser);

    await page.goto(`http://127.0.0.1:${frontendPort}/login`, { waitUntil: 'networkidle0' });
    await page.evaluate(
      (t, u) => {
        localStorage.setItem('smartpool_token', t);
        localStorage.setItem('token', t);
        localStorage.setItem(
          'user',
          JSON.stringify({
            _id: u._id,
            name: u.name,
            email: u.email,
            phone: u.phone,
            role: 'customer',
          })
        );
      },
      customerToken,
      { _id: String(customerUser._id), name: customerUser.name, email: customerUser.email, phone: customerUser.phone }
    );

    // ==========================================
    // TEST CASE A: Accepted Booking Timeline
    // ==========================================
    console.log(`\nNavigating to Accepted Booking: /bookings/${acceptedBooking._id}...`);
    await page.goto(`http://127.0.0.1:${frontendPort}/bookings/${acceptedBooking._id}`, {
      waitUntil: 'networkidle0',
    });
    await new Promise((r) => setTimeout(r, 1200));

    const acceptedPageText = await page.evaluate(() => document.body.innerText);
    console.log('Accepted Page Preview:\n', acceptedPageText.slice(0, 400));

    // Assert that "Service Fulfillment Timeline" is present
    if (!/Service Fulfillment Timeline/i.test(acceptedPageText)) {
      throw new Error('Accepted booking missing "Service Fulfillment Timeline"');
    }
    if (!/Current Stage:\s*Accepted/i.test(acceptedPageText)) {
      throw new Error('Accepted booking does not show "Current Stage: Accepted"');
    }

    // Inspect timeline steps rendering
    const acceptedStepStatus = await page.evaluate(() => {
      const stepLabels = Array.from(document.querySelectorAll('.grid-cols-7 > div'));
      return stepLabels.map((el) => {
        const text = el.querySelector('span')?.innerText;
        const bar = el.querySelector('.h-2');
        const isGreen = bar?.classList.contains('bg-emerald-600');
        const isCurrentRing = bar?.classList.contains('ring-2');
        return { text, isGreen, isCurrentRing };
      });
    });

    console.log('Accepted Booking Timeline Step Breakdown:', acceptedStepStatus);

    // Verify: Steps 0..3 are green; Step 3 ('Accepted') has ring; Steps 4..6 are NOT green
    const acceptedStep = acceptedStepStatus.find(s => s.text === 'Accepted');
    const arrivedStepForAccepted = acceptedStepStatus.find(s => s.text === 'Arrived');
    const completedStepForAccepted = acceptedStepStatus.find(s => s.text === 'Completed');

    if (!acceptedStep || !acceptedStep.isGreen || !acceptedStep.isCurrentRing) {
      throw new Error('Accepted step must be active with green bar and highlight ring');
    }
    if (arrivedStepForAccepted?.isGreen) {
      throw new Error('Arrived step must NOT be green for accepted booking');
    }
    if (completedStepForAccepted?.isGreen) {
      throw new Error('Completed step must NOT be green for accepted booking');
    }

    const screenshotA = path.join(SCREENSHOT_DIR, '01_customer_booking_accepted_timeline.png');
    await page.screenshot({ path: screenshotA });
    console.log(`Captured screenshot for Accepted Booking: ${screenshotA}`);

    // Verify persistence after page refresh
    console.log('Verifying timeline persistence across page reload...');
    await page.reload({ waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 1000));
    const reloadedText = await page.evaluate(() => document.body.innerText);
    if (!/Current Stage:\s*Accepted/i.test(reloadedText)) {
      throw new Error('Timeline state lost or corrupted after page reload');
    }
    console.log('Timeline persistence confirmed across reload.');

    // ==========================================
    // TEST CASE B: Arrived Booking Timeline
    // ==========================================
    console.log(`\nNavigating to Arrived Booking: /bookings/${arrivedBooking._id}...`);
    await page.goto(`http://127.0.0.1:${frontendPort}/bookings/${arrivedBooking._id}`, {
      waitUntil: 'networkidle0',
    });
    await new Promise((r) => setTimeout(r, 1200));

    const arrivedPageText = await page.evaluate(() => document.body.innerText);
    if (!/Current Stage:\s*Arrived/i.test(arrivedPageText)) {
      throw new Error('Arrived booking does not show "Current Stage: Arrived"');
    }

    const arrivedStepStatus = await page.evaluate(() => {
      const stepLabels = Array.from(document.querySelectorAll('.grid-cols-7 > div'));
      return stepLabels.map((el) => {
        const text = el.querySelector('span')?.innerText;
        const bar = el.querySelector('.h-2');
        const isGreen = bar?.classList.contains('bg-emerald-600');
        const isCurrentRing = bar?.classList.contains('ring-2');
        return { text, isGreen, isCurrentRing };
      });
    });

    console.log('Arrived Booking Timeline Step Breakdown:', arrivedStepStatus);

    const arrivedStep = arrivedStepStatus.find(s => s.text === 'Arrived');
    const inProgressStepForArrived = arrivedStepStatus.find(s => s.text === 'In Progress');
    const completedStepForArrived = arrivedStepStatus.find(s => s.text === 'Completed');

    if (!arrivedStep || !arrivedStep.isGreen || !arrivedStep.isCurrentRing) {
      throw new Error('Arrived step must be active with green bar and highlight ring');
    }
    if (inProgressStepForArrived?.isGreen) {
      throw new Error('In Progress step must NOT be green for arrived booking');
    }
    if (completedStepForArrived?.isGreen) {
      throw new Error('Completed step must NOT be green for arrived booking');
    }

    const screenshotB = path.join(SCREENSHOT_DIR, '02_customer_booking_arrived_timeline.png');
    await page.screenshot({ path: screenshotB });
    console.log(`Captured screenshot for Arrived Booking: ${screenshotB}`);

    // ==========================================
    // TEST CASE C: Cancelled Booking
    // ==========================================
    console.log(`\nNavigating to Cancelled Booking: /bookings/${cancelledBooking._id}...`);
    await page.goto(`http://127.0.0.1:${frontendPort}/bookings/${cancelledBooking._id}`, {
      waitUntil: 'networkidle0',
    });
    await new Promise((r) => setTimeout(r, 1200));

    const cancelledPageText = await page.evaluate(() => document.body.innerText);
    if (!/Booking Cancelled/i.test(cancelledPageText)) {
      throw new Error('Cancelled booking does not show "Booking Cancelled" alert');
    }
    if (/Service Fulfillment Timeline/i.test(cancelledPageText)) {
      throw new Error('Cancelled booking must NOT show standard service fulfillment timeline');
    }

    const screenshotC = path.join(SCREENSHOT_DIR, '03_customer_booking_cancelled_timeline.png');
    await page.screenshot({ path: screenshotC });
    console.log(`Captured screenshot for Cancelled Booking: ${screenshotC}`);

    console.log('\n>>> DEF-04 Browser E2E Verification PASSED with 100% SUCCESS <<<\n');
  } catch (err) {
    console.error('DEF-04 Verification Error:', err);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (servers) {
      servers.backendServer.close();
      servers.frontendServer.close();
    }
    if (mongoose.connection.readyState !== 0) {
      await disconnectDB();
    }
    if (replSet) {
      await replSet.stop();
    }
    process.exit(process.exitCode || 0);
  }
}

main();

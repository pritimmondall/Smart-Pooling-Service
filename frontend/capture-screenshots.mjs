import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { MongoMemoryReplSet } from '../backend/node_modules/mongodb-memory-server/index.js';
import mongoose from '../backend/node_modules/mongoose/index.js';

import app from '../backend/src/app.js';
import {
  User,
  ServiceCategory,
  ServiceZone,
  TechnicianProfile,
  ServicePool,
  Booking,
} from '../backend/src/models/index.js';
import { signAuthToken } from '../backend/src/middleware/auth.js';
import { toGeoJSONPoint } from '../backend/src/utils/geo.js';

const SCREENSHOT_DIR = '/home/monkey-d-luffy/.gemini/antigravity/brain/c62026ab-22da-42cf-ae9c-8f4348656f27/screenshots';
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const CHROME_PATH = '/usr/bin/google-chrome';
const FRONTEND_DIST = path.resolve('dist');

import express from '../backend/node_modules/express/index.js';

// Express static app with API proxy
function startUnifiedServer(backendPort, frontendPort) {
  return new Promise((resolve) => {
    // 1. Backend Server
    const backendServer = http.createServer(app);
    backendServer.listen(backendPort, () => {
      console.log(`Backend test server listening on port ${backendPort}`);

      // 2. Frontend Express Server with API proxy to backend
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
      frontendApp.get('*', (_req, res) => {
        res.sendFile(path.join(FRONTEND_DIST, 'index.html'));
      });

      const frontendServer = frontendApp.listen(frontendPort, () => {
        console.log(`Frontend test server listening on port ${frontendPort}`);
        resolve({ backendServer, frontendServer });
      });
    });
  });
}

async function run() {
  console.log('--- STARTING SECTION 5: SCREENSHOT CAPTURE SUITE ---');

  // 1. Start In-Memory MongoDB Replica Set
  console.log('Starting MongoDB Memory Replica Set...');
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  const mongoUri = replSet.getUri();
  await mongoose.connect(mongoUri);
  console.log('Connected to In-Memory DB:', mongoUri);

  // 2. Seed Test Technician and Assigned Jobs
  console.log('Seeding demo technician and assignments...');
  const catAc = await ServiceCategory.create({
    name: 'Air Conditioner Deep Cleaning',
    slug: 'ac-cleaning',
    baseIndividualPrice: 850,
    estimatedDurationMins: 45,
    isActive: true,
  });

  const catAppliance = await ServiceCategory.create({
    name: 'Appliance Maintenance',
    slug: 'appliance-repair',
    baseIndividualPrice: 600,
    estimatedDurationMins: 40,
    isActive: true,
  });

  const zone = await ServiceZone.create({
    name: 'Kolkata South Zone',
    code: 'KOL-SOUTH',
    city: 'Kolkata',
    state: 'WB',
    centerLocation: toGeoJSONPoint(22.5015, 88.3531),
    boundary: {
      type: 'Polygon',
      coordinates: [
        [
          [88.3, 22.45],
          [88.42, 22.45],
          [88.42, 22.55],
          [88.3, 22.55],
          [88.3, 22.45],
        ],
      ],
    },
    isActive: true,
  });

  const techUser = await User.create({
    name: 'Rohit Kumar (Certified Tech)',
    email: 'tech.rohit@smartpool.demo',
    phone: '+91-9830112233',
    passwordHash: 'fakehash123',
    role: 'technician',
    isActive: true,
  });

  const techProfile = await TechnicianProfile.create({
    userId: techUser._id,
    approvalStatus: 'approved',
    availabilityStatus: 'available',
    serviceCategories: [catAc._id, catAppliance._id],
    zoneId: zone._id,
    serviceRadiusKm: 15,
    maxPoolCapacity: 4,
    activeWorkload: 1,
    jobsCompleted: 28,
    baseLocation: toGeoJSONPoint(22.5176, 88.3639),
    addressText: 'Ballygunge Circular Rd, Kolkata, West Bengal 700019',
    workingHours: {
      start: '09:00',
      end: '18:00',
      daysOfWeek: [1, 2, 3, 4, 5, 6],
    },
  });

  // Seed Customers
  const customer1 = await User.create({
    name: 'Aarav Sen',
    email: 'aarav@smartpool.demo',
    phone: '+91-9876543210',
    passwordHash: 'fakehash123',
    role: 'customer',
  });
  const customer2 = await User.create({
    name: 'Riya Chatterjee',
    email: 'riya@smartpool.demo',
    phone: '+91-9876543211',
    passwordHash: 'fakehash123',
    role: 'customer',
  });
  const customer3 = await User.create({
    name: 'Subham Roy',
    email: 'subham@smartpool.demo',
    phone: '+91-9876543212',
    passwordHash: 'fakehash123',
    role: 'customer',
  });

  // Seed Pooled Job
  const baseTime = new Date('2026-11-20T10:00:00.000Z');
  const poolBooking1 = await Booking.create({
    customerId: customer1._id,
    serviceCategoryId: catAc._id,
    zoneId: zone._id,
    addressText: 'Flat 4B, South City Tower 2, Prince Anwar Shah Rd, Kolkata',
    location: toGeoJSONPoint(22.5015, 88.3611),
    timeWindow: {
      start: new Date(baseTime.getTime()),
      end: new Date(baseTime.getTime() + 2 * 3600000),
    },
    status: 'assigned',
    bookingMode: 'pool',
    estimatedPrice: 765,
    finalPrice: 765,
    technicianId: techUser._id,
    notes: 'Please buzz flat 4B at entrance gate',
  });

  const poolBooking2 = await Booking.create({
    customerId: customer2._id,
    serviceCategoryId: catAc._id,
    zoneId: zone._id,
    addressText: '18/2 Gariahat Rd, Near Golpark, Kolkata',
    location: toGeoJSONPoint(22.5152, 88.3644),
    timeWindow: {
      start: new Date(baseTime.getTime() + 30 * 60000),
      end: new Date(baseTime.getTime() + 2.5 * 3600000),
    },
    status: 'assigned',
    bookingMode: 'pool',
    estimatedPrice: 765,
    finalPrice: 765,
    technicianId: techUser._id,
    notes: 'Ground floor bungalow. Dog is locked inside.',
  });

  const servicePool = await ServicePool.create({
    serviceCategoryId: catAc._id,
    zoneId: zone._id,
    status: 'assigned',
    aggregateTimeWindow: {
      start: new Date(baseTime.getTime()),
      end: new Date(baseTime.getTime() + 3 * 3600000),
    },
    lockCutoffTime: new Date(baseTime.getTime() - 2 * 3600000),
    centroidLocation: toGeoJSONPoint(22.5083, 88.3627),
    poolRadiusKm: 2.5,
    radiusKm: 2.5,
    maxCapacity: 4,
    pricing: {
      basePrice: 850,
      currentDiscountPercent: 10,
      currentDiscountedPrice: 765,
    },
    members: [
      {
        bookingId: poolBooking1._id,
        customerId: customer1._id,
        status: 'active',
        addressText: poolBooking1.addressText,
        location: poolBooking1.location,
        joinedAt: new Date(),
      },
      {
        bookingId: poolBooking2._id,
        customerId: customer2._id,
        status: 'active',
        addressText: poolBooking2.addressText,
        location: poolBooking2.location,
        joinedAt: new Date(),
      },
    ],
    assignedTechnicianId: techUser._id,
    assignedAt: new Date(),
  });

  poolBooking1.poolId = servicePool._id;
  await poolBooking1.save();
  poolBooking2.poolId = servicePool._id;
  await poolBooking2.save();

  // Seed Individual Booking Job (Accepted status)
  const indBooking = await Booking.create({
    customerId: customer3._id,
    serviceCategoryId: catAppliance._id,
    zoneId: zone._id,
    addressText: '24 Hindusthan Park, Gariahat, Kolkata 700029',
    location: toGeoJSONPoint(22.5188, 88.3622),
    timeWindow: {
      start: new Date(baseTime.getTime() + 4 * 3600000),
      end: new Date(baseTime.getTime() + 6 * 3600000),
    },
    status: 'accepted',
    bookingMode: 'individual',
    estimatedPrice: 600,
    finalPrice: 600,
    technicianId: techUser._id,
    assignedAt: new Date(Date.now() - 3600000),
    acceptedAt: new Date(),
    notes: 'Microwave oven making buzzing noise when heating',
  });

  // Seed Completed Job
  const compBooking = await Booking.create({
    customerId: customer1._id,
    serviceCategoryId: catAc._id,
    zoneId: zone._id,
    addressText: 'Flat 4B, South City Tower 2, Kolkata',
    location: toGeoJSONPoint(22.5015, 88.3611),
    timeWindow: {
      start: new Date(baseTime.getTime() - 24 * 3600000),
      end: new Date(baseTime.getTime() - 22 * 3600000),
    },
    status: 'completed',
    bookingMode: 'individual',
    estimatedPrice: 850,
    finalPrice: 850,
    technicianId: techUser._id,
    assignedAt: new Date(Date.now() - 26 * 3600000),
    acceptedAt: new Date(Date.now() - 25 * 3600000),
    startedAt: new Date(Date.now() - 24 * 3600000),
    completedAt: new Date(Date.now() - 23 * 3600000),
  });

  // Generate Auth Token
  const token = signAuthToken(techUser);
  console.log('Seeding complete. Technician Auth Token generated.');

  // 3. Start Unified Servers
  const BACKEND_PORT = 5001;
  const FRONTEND_PORT = 5173;
  const { backendServer, frontendServer } = await startUnifiedServer(BACKEND_PORT, FRONTEND_PORT);

  // 4. Launch Browser via Puppeteer
  console.log('Launching headless browser for screenshots...');
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  page.on('console', (msg) => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', (err) => console.log('PAGE ERROR:', err.message));
  page.on('requestfailed', (req) => console.log('REQ FAILED:', req.url(), req.failure()?.errorText));
  page.on('response', (res) => {
    if (res.status() >= 400 || res.url().includes('/api/')) {
      console.log('RES:', res.status(), res.url());
    }
  });

  // Set auth token in localStorage
  await page.goto(`http://localhost:${FRONTEND_PORT}/login`, { waitUntil: 'networkidle2' });
  await page.evaluate((tok) => {
    localStorage.setItem('smartpool_token', tok);
  }, token);

  // VIEWPORT 1: Desktop Overview (1440 x 900)
  console.log('Capturing Desktop Overview...');
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`http://localhost:${FRONTEND_PORT}/`, { waitUntil: 'networkidle2' });
  console.log('Current page URL:', page.url());
  console.log('Page body HTML snippet:', (await page.content()).slice(0, 500));
  await page.waitForSelector('main', { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 1000));

  const desktopScreenshot = path.join(SCREENSHOT_DIR, '01_technician_dashboard_desktop.png');
  await page.screenshot({ path: desktopScreenshot, fullPage: true });
  console.log(`Saved: ${desktopScreenshot}`);

  // VIEWPORT 2: Route & Multi-Stop Sequence Modal
  console.log('Capturing Optimized Route Modal...');
  // Click "View Optimized Route" button
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const routeBtn = buttons.find((b) => b.textContent.includes('Optimized Route') || b.textContent.includes('Route'));
    if (routeBtn) routeBtn.click();
  });
  await new Promise((r) => setTimeout(r, 1500));

  const routeModalScreenshot = path.join(SCREENSHOT_DIR, '02_technician_route_modal.png');
  await page.screenshot({ path: routeModalScreenshot });
  console.log(`Saved: ${routeModalScreenshot}`);

  // Close modal
  await page.evaluate(() => {
    const closeBtn = document.querySelector('button[aria-label="Close modal"]');
    if (closeBtn) closeBtn.click();
  });
  await new Promise((r) => setTimeout(r, 600));

  // VIEWPORT 3: Full Job Details Modal
  console.log('Capturing Job Full Details Modal...');
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const detailsBtn = buttons.find((b) => b.textContent.includes('Full Details'));
    if (detailsBtn) detailsBtn.click();
  });
  await new Promise((r) => setTimeout(r, 1500));

  const detailsModalScreenshot = path.join(SCREENSHOT_DIR, '03_technician_job_details_modal.png');
  await page.screenshot({ path: detailsModalScreenshot });
  console.log(`Saved: ${detailsModalScreenshot}`);

  // Close modal
  await page.evaluate(() => {
    const closeBtn = document.querySelector('button[aria-label="Close modal"]');
    if (closeBtn) closeBtn.click();
  });
  await new Promise((r) => setTimeout(r, 600));

  // VIEWPORT 4: Tablet View (768 x 1024)
  console.log('Capturing Tablet View...');
  await page.setViewport({ width: 768, height: 1024 });
  await new Promise((r) => setTimeout(r, 800));
  const tabletScreenshot = path.join(SCREENSHOT_DIR, '04_technician_dashboard_tablet.png');
  await page.screenshot({ path: tabletScreenshot, fullPage: true });
  console.log(`Saved: ${tabletScreenshot}`);

  // VIEWPORT 5: Mobile View (390 x 844)
  console.log('Capturing Mobile View...');
  await page.setViewport({ width: 390, height: 844 });
  await new Promise((r) => setTimeout(r, 800));
  const mobileScreenshot = path.join(SCREENSHOT_DIR, '05_technician_dashboard_mobile.png');
  await page.screenshot({ path: mobileScreenshot, fullPage: true });
  console.log(`Saved: ${mobileScreenshot}`);

  // Cleanup
  console.log('Cleaning up browser and test servers...');
  await browser.close();
  frontendServer.close();
  backendServer.close();
  await mongoose.disconnect();
  await replSet.stop();
  console.log('--- ALL SCREENSHOTS SUCCESSFULLY CAPTURED ---');
}

run().catch((err) => {
  console.error('Screenshot capture failed:', err);
  process.exit(1);
});

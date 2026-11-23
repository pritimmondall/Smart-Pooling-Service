import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { test } from 'node:test';
import puppeteer from 'puppeteer-core';
import { notifyMatchingWatches } from '../../backend/src/modules/pools/watch.service.js';
import { createApp } from '../../backend/src/app.js';
import { connectDB, disconnectDB } from '../../backend/src/config/db.js';
import { env } from '../../backend/src/config/env.js';
import { User, ServiceCategory, TechnicianProfile } from '../../backend/src/models/index.js';

const requireBackend = createRequire(new URL('../../backend/package.json', import.meta.url));
const { MongoMemoryReplSet } = requireBackend('mongodb-memory-server');

test('two customers share a quoted pool, the technician completes both stops, and both customers rate', async t => {
  env.routingProvider = 'mock';
  const db = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  t.after(async () => { await disconnectDB(); await db.stop(); });
  await connectDB(db.getUri());
  const service = await ServiceCategory.create({ name: 'AC service', slug: 'ac-service',
    baseIndividualPrice: 600, estimatedDurationMins: 30, maxPoolSize: 2 });
  const password = 'LocalDemo123!';
  const accounts = await User.create(['First', 'Second', 'Technician'].map((name, i) => ({
    name, email: name.toLowerCase() + '@demo.example', passwordHash: password,
    role: i === 2 ? 'technician' : 'customer',
    poolAlertLocation: { type: 'Point', coordinates: [88.36, 22.52 + i * 0.0003] },
  })));
  await TechnicianProfile.create({ userId: accounts[2]._id, serviceCategories: [service._id],
    approvalStatus: 'approved', availabilityStatus: 'available', baseLocation: accounts[2].poolAlertLocation });
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await puppeteer.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
  t.after(() => browser.close());

  async function login(account) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.goto(origin + '/login', { waitUntil: 'domcontentloaded' });
    await page.type('input[type=email]', account.email);
    await page.type('input[type=password]', password);
    await page.click('button[type=submit]');
    await page.waitForFunction(() => location.pathname !== '/login');
    return page;
  }

  async function click(page, label) {
    const button = await page.waitForFunction(text => [...document.querySelectorAll('button')]
      .find(el => el.textContent.trim() === text && !el.disabled), {}, label);
    await button.asElement().click();
    await button.dispose();
  }

  const customers = [];
  let firstWindow;
  for (const [index, account] of accounts.slice(0, 2).entries()) {
    const page = await login(account);
    customers.push(page);
    const value = service.id + '/AC service';
    await page.waitForSelector('option[value="' + value + '"]');
    await page.select('form select', value);
    if (index === 0) {
      firstWindow = await page.$eval('input[type=datetime-local]', input => input.value);
      const individualUrl = await page.$eval('a::-p-text(Book individually)', link => link.href);
      const individual = await page.browserContext().newPage();
      await individual.goto(individualUrl, { waitUntil: 'domcontentloaded' });
      await individual.waitForFunction(() => [...document.querySelectorAll('select')].some(el => el.value === 'individual')
        && [...document.querySelectorAll('select')].some(el => el.value === 'AC service'));
      await individual.close();
    } else {
      await page.waitForFunction(() => document.body.innerText.includes('₹540 if you join'));
    }
    if (index) {
      await page.$$eval('input[type=datetime-local]', (inputs, firstStart) => {
        const end = new Date(firstStart);
        const start = new Date(+end - 3600000);
        for (const [i, date] of [start, end].entries()) {
          const local = new Date(+date - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(inputs[i], local);
          inputs[i].dispatchEvent(new Event('input', { bubbles: true }));
        }
      }, firstWindow);
      await page.click('input[type=checkbox]');
    }
    await click(page, 'Find my best pool');
    if (index) {
      await page.waitForFunction(() => document.body.innerText.includes('1h later'));
      await page.click('input[name=visit-window]:not(:checked)');
    }
    await page.waitForFunction(price => document.body.innerText.includes(price + ' each after booking'), {}, index ? '₹540' : '₹600');
    if (index) {
      await page.waitForFunction(() => document.body.innerText.includes('Save ₹60 (10%)'));
      await page.click('summary::-p-text(Watch for a price)');
      await page.type('details input[type=number]', '540');
      await click(page, 'Save price watch');
      await page.waitForFunction(() => document.body.innerText.includes('Watch saved.'));
      await notifyMatchingWatches();
      const inbox = await page.browserContext().newPage();
      await inbox.goto(origin + '/notifications', { waitUntil: 'domcontentloaded' });
      const alert = await inbox.waitForSelector('a[href*="watch=1"]');
      await alert.click();
      await inbox.waitForFunction(() => document.body.innerText.includes('₹540 after joining'));
      await inbox.close();
    }
    if (!index) await page.type('input[placeholder="No limit · keep my visit"]', '550');
    await click(page, index ? 'Confirm pooled booking' : 'Start a pool');
    await page.waitForFunction(() => location.pathname.startsWith('/bookings/'));
    if (!index) {
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.body.innerText.includes('1 member · ₹600 each') && document.body.innerText.includes('One more neighbour') && document.body.innerText.includes('₹550'));
    }
  }
  await customers[0].waitForFunction(() => document.body.innerText.includes('2 members · ₹540 each'));
  const tech = await login(accounts[2]);
  await click(tech, 'Claim job');
  await click(tech, 'Accept');
  await customers[0].waitForFunction(() => document.body.innerText.includes('Technician · Technician') && document.body.innerText.includes('Estimated visit ·') && /visit before yours|Your visit is next/.test(document.body.innerText));
  for (let stop = 0; stop < 2; stop++) {
    for (const [label, action] of [['Mark Arrived', 'arrive'], ['Start Service', 'start'], ['Complete Service', 'complete']]) {
      const [response] = await Promise.all([
        tech.waitForResponse(res => res.url().includes('/stops/') && res.url().endsWith('/' + action)),
        click(tech, label),
      ]);
      assert.equal(response.status(), 200);
    }
  }
  for (const page of customers) {
    if (new URL(page.url()).pathname === '/') {
      const link = await page.waitForSelector('a::-p-text(Confirm completion and rate)');
      await link.click();
    } else await page.reload({ waitUntil: 'domcontentloaded' });
    await click(page, 'Confirm completion');
    await page.waitForSelector('option[value="5"]');
    await page.select('form select', '5');
    await click(page, 'Submit rating');
    await page.waitForFunction(() => document.body.innerText.includes('5/5'));
    assert.ok(page.url().includes('/bookings/'));
  }
});

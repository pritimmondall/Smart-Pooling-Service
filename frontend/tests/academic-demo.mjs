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

test('three customers see a private visit sequence, follow the technician through three stops, and rate their visits', async t => {
  env.routingProvider = 'mock';
  const db = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  t.after(async () => { await disconnectDB(); await db.stop(); });
  await connectDB(db.getUri());
  const service = await ServiceCategory.create({ name: 'AC service', slug: 'ac-service',
    baseIndividualPrice: 600, estimatedDurationMins: 15, maxPoolSize: 3 });
  const password = 'LocalDemo123!';
  const accounts = await User.create(['First', 'Second', 'Third', 'Technician'].map((name, i) => ({
    name, email: name.toLowerCase() + '@demo.example', passwordHash: password,
    role: i === 3 ? 'technician' : 'customer',
    poolAlertLocation: { type: 'Point', coordinates: [88.36, 22.5198 + i * 0.0007] },
  })));
  await TechnicianProfile.create({ userId: accounts[3]._id, serviceCategories: [service._id],
    approvalStatus: 'approved', availabilityStatus: 'available', baseLocation: accounts[3].poolAlertLocation });
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await puppeteer.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
  t.after(() => browser.close());

  await t.test('sign-up creates the selected account type', async () => {
    for (const role of ['customer', 'technician']) {
      const context = await browser.createBrowserContext();
      try {
        const page = await context.newPage();
        await page.goto(origin + '/register', { waitUntil: 'domcontentloaded' });
        await page.click(`input[name=role][value=${role}]`);
        if (role === 'technician') await click(page, 'Ballygunge');
        await page.type('input[name=name]', 'New ' + role);
        await page.type('input[name=email]', role + '@registration.example');
        await page.type('input[name=password]', password);
        await page.type('input[name=confirmPassword]', password);
        await page.click('button[type=submit]');
        await page.waitForFunction(expected => location.pathname === expected, {}, role === 'technician' ? '/technician/profile-setup' : '/');
        if (role === 'technician') {
          await page.reload({ waitUntil: 'domcontentloaded' });
          await click(page, 'Save work profile');
          await page.waitForFunction(() => document.body.innerText.includes('Select at least one service field.'));
          await page.click('input[name=serviceCategories][value="' + service.id + '"]');
          await page.$eval('input[name=serviceRadiusKm]', input => {
            input.focus();
            input.select();
          });
          await page.keyboard.type('14');
          await page.click('input[name=workingDay][value="6"]');
          await click(page, 'Save work profile');
          await page.waitForSelector('.tech-desk');
        }
        const user = await User.findOne({ email: role + '@registration.example' });
        assert.equal(user.role, role);
        const profile = await TechnicianProfile.findOne({ userId: user._id });
        if (role === 'technician') {
          assert.equal(profile.approvalStatus, 'pending');
          assert.equal(profile.serviceRadiusKm, 14);
          assert.deepEqual(Array.from(profile.workingHours.daysOfWeek), [1, 2, 3, 4, 5]);
          assert.deepEqual(profile.serviceCategories.map(String), [service.id]);
          assert.deepEqual(Array.from(profile.baseLocation.coordinates), [88.3639, 22.5176]);
          await page.waitForSelector('.tech-desk');
        } else {
          assert.equal(profile, null);
          await page.waitForSelector('a[href="/create-booking"]');
        }
      } finally {
        await context.close();
      }
    }
  });

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
  for (const [index, account] of accounts.slice(0, 3).entries()) {
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
      await page.waitForFunction(price => document.body.innerText.includes(price + ' if you join'), {}, index === 1 ? '₹540' : '₹510');
    }
    if (index === 1) {
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
    if (index === 1) {
      await page.waitForFunction(() => document.body.innerText.includes('1h later'));
      await page.click('input[name=visit-window]:not(:checked)');
    }
    await page.waitForFunction(price => document.body.innerText.includes(price + ' each after booking'), {}, ['₹600', '₹540', '₹510'][index]);
    if (index === 1) {
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
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    if (!index) {
      await page.waitForFunction(() => document.body.innerText.includes('1 member · ₹600 each') && document.body.innerText.includes('One more neighbour') && document.body.innerText.includes('₹550'));
      await click(page, 'Edit lock cutoff');
      await page.$eval('input[type=datetime-local]', input => {
        const date = new Date(new Date(input.value).getTime() - 5 * 60000);
        const value = new Date(+date - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await click(page, 'Save cutoff');
      await page.waitForFunction(() => document.body.innerText.includes('Joining deadline updated.'));
    }
  }
  await customers[0].waitForFunction(() => document.body.innerText.includes('3 members · ₹510 each'));
  const tech = await login(accounts[3]);
  await tech.waitForFunction(() => document.body.innerText.includes('/hour estimated gross'));
  await click(tech, 'Claim job');
  for (const page of customers) {
    assert.equal(await page.$('[aria-label="Visit route"]'), null);
  }
  await click(tech, 'Accept');
  await tech.waitForFunction(() => document.querySelectorAll('.visit-pin').length === 3);
  await tech.waitForSelector('a[href*="maps/dir/"]');
  await click(tech, 'Report visit issue');
  await tech.waitForFunction(() => document.body.innerText.includes('Other visits in this pool will continue.'));
  await tech.keyboard.press('Escape');
  await customers[0].waitForFunction(() => document.body.innerText.includes('Technician · Technician') && document.body.innerText.includes('Estimated visit ·') && /visit before yours|Your visit is next/.test(document.body.innerText));
  const byVisit = new Map();
  for (const [index, page] of customers.entries()) {
    await page.waitForSelector('.customer-visit-map.leaflet-container');
    await page.waitForSelector('.visit-pin');
    assert.equal(await page.$$eval('.visit-route li', items => items.length), 3);
    const route = await page.evaluate(async () => {
      const result = await fetch('/api/v1/bookings/dashboard', {
        headers: { Authorization: 'Bearer ' + localStorage.getItem('smartpool_token') },
      });
      return (await result.json()).data.visitRoute;
    });
    assert.deepEqual(route.stops.map(stop => stop.number), [1, 2, 3]);
    assert.equal(route.stops.filter(stop => stop.yours).length, 1);
    const own = route.stops.find(stop => stop.yours);
    assert.deepEqual(own.point, Array.from(accounts[index].poolAlertLocation.coordinates));
    for (const other of route.stops.filter(stop => !stop.yours)) {
      assert.deepEqual(Object.keys(other).sort(), ['number', 'point', 'status', 'yours']);
      assert.ok(accounts.every(account => JSON.stringify(other.point) !== JSON.stringify(account.poolAlertLocation.coordinates)));
    }
    byVisit.set(own.number, page);
    await click(page, 'Hide map');
    assert.equal(await page.$('.customer-visit-map'), null);
    assert.equal(await page.$$eval('.visit-route li', items => items.length), 3);
    await click(page, 'Show map');
  }
  assert.equal(byVisit.size, 3);
  for (let stop = 0; stop < 3; stop++) {
    for (const [label, action] of [['Mark Arrived', 'arrive'], ['Start Service', 'start'], ['Complete Service', 'complete']]) {
      const [response] = await Promise.all([
        tech.waitForResponse(res => res.url().includes('/stops/') && res.url().endsWith('/' + action)),
        click(tech, label),
      ]);
      assert.equal(response.status(), 200);
    }
    if (stop === 0) {
      await byVisit.get(2).waitForFunction(() => document.body.innerText.includes('Your visit is next')
        && document.querySelector('.visit-route li')?.textContent.includes('Completed'));
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

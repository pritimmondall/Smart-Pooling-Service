/**
 * Idempotent Phase 2 Demo Seed Script.
 * Seeds sample Service Categories, Service Zones, Admin, Customer, and Technician accounts in Kolkata.
 * NOTE: All seeded data is synthetic demo data for development and manual testing only.
 */
import { validateEnv } from '../config/env.js';
import { connectDB, disconnectDB } from '../config/db.js';
import { User, ServiceCategory, ServiceZone, TechnicianProfile } from '../models/index.js';
import { toGeoJSONPoint } from '../utils/geo.js';

const DEMO_CATEGORIES = [
  {
    name: 'AC Service & Repair',
    slug: 'ac-service',
    description: 'Split/Window AC servicing, filter cleaning, and cooling checkup.',
    baseIndividualPrice: 600,
    estimatedDurationMins: 45,
    defaultPoolRadiusKm: 0.2,
    maxPoolSize: 4,
    poolLockCutoffMins: 60,
  },
  {
    name: 'Plumbing',
    slug: 'plumbing',
    description: 'Tap/pipe leak repair, drainage cleaning, and fixture installation.',
    baseIndividualPrice: 450,
    estimatedDurationMins: 40,
    defaultPoolRadiusKm: 0.2,
    maxPoolSize: 4,
    poolLockCutoffMins: 60,
  },
  {
    name: 'Electrical',
    slug: 'electrical',
    description: 'Switchboard repair, fan installation, wiring fault inspection.',
    baseIndividualPrice: 400,
    estimatedDurationMins: 35,
    defaultPoolRadiusKm: 0.2,
    maxPoolSize: 4,
    poolLockCutoffMins: 60,
  },
  {
    name: 'Home Cleaning',
    slug: 'home-cleaning',
    description: 'Bathroom, kitchen, or room deep-cleaning service.',
    baseIndividualPrice: 800,
    estimatedDurationMins: 60,
    defaultPoolRadiusKm: 0.2,
    maxPoolSize: 3,
    poolLockCutoffMins: 90,
  },
  {
    name: 'Appliance Repair',
    slug: 'appliance-repair',
    description: 'Washing machine, refrigerator, and microwave diagnostics.',
    baseIndividualPrice: 550,
    estimatedDurationMins: 45,
    defaultPoolRadiusKm: 0.2,
    maxPoolSize: 4,
    poolLockCutoffMins: 60,
  },
];

const DEMO_ZONES = [
  {
    name: 'Green Park / Jadavpur',
    code: 'KOL-SOUTH-GP',
    city: 'Kolkata',
    coords: { lat: 22.5015, lng: 88.3531 },
    radiusKm: 3,
  },
  {
    name: 'Ballygunge',
    code: 'KOL-CENTRAL-BAL',
    city: 'Kolkata',
    coords: { lat: 22.5176, lng: 88.3639 },
    radiusKm: 3,
  },
  {
    name: 'Salt Lake Sector II',
    code: 'KOL-EAST-SL2',
    city: 'Kolkata',
    coords: { lat: 22.5867, lng: 88.4171 },
    radiusKm: 4,
  },
];

async function upsertUser({ name, email, phone, password, role }) {
  const existing = await User.findOne({ email });
  if (existing) return existing;
  return User.create({
    name,
    email,
    phone,
    passwordHash:
      process.env.NODE_ENV === 'production'
        ? process.env[`SEED_${role.toUpperCase()}_PASSWORD`] || password
        : password,
    role,
    isActive: true,
  });
}

async function seed() {
  validateEnv();
  await connectDB();

  const categoryMap = new Map();
  for (const cat of DEMO_CATEGORIES) {
    const doc = await ServiceCategory.findOneAndUpdate(
      { slug: cat.slug },
      { $setOnInsert: cat },
      { upsert: true, new: true }
    );
    categoryMap.set(cat.slug, doc);
  }

  const zoneMap = new Map();
  for (const z of DEMO_ZONES) {
    const doc = await ServiceZone.findOneAndUpdate(
      { code: z.code },
      {
        $setOnInsert: {
          name: z.name,
          code: z.code,
          city: z.city,
          centerLocation: toGeoJSONPoint(z.coords.lat, z.coords.lng),
          radiusKm: z.radiusKm,
          isActive: true,
        },
      },
      { upsert: true, new: true }
    );
    zoneMap.set(z.code, doc);
  }

  await upsertUser({
    name: 'Platform Admin (Demo)',
    email: 'admin@smartpool.demo',
    phone: '+91-9000000001',
    password: 'AdminDemo123!',
    role: 'admin',
  });

  const demoCustomers = [
    { name: 'Aarav Sen (Demo)', email: 'customer1@smartpool.demo', phone: '+91-9000000101' },
    { name: 'Riya Chatterjee (Demo)', email: 'customer2@smartpool.demo', phone: '+91-9000000102' },
    { name: 'Subham Roy (Demo)', email: 'customer3@smartpool.demo', phone: '+91-9000000103' },
  ];
  for (const [i, c] of demoCustomers.entries()) {
    const customer = await upsertUser({ ...c, password: 'CustomerDemo123!', role: 'customer' });
    await User.updateOne({ _id: customer._id, poolAlertLocation: null }, {
      poolAlertLocation: toGeoJSONPoint(22.5015 + i * 0.0005, 88.3531),
    });
  }

  const demoTechnicians = [
    {
      name: 'Rohit Kumar (Demo)',
      email: 'tech.ac@smartpool.demo',
      phone: '+91-9000000201',
      categories: ['ac-service', 'appliance-repair'],
      zoneCode: 'KOL-CENTRAL-BAL',
      coords: { lat: 22.5176, lng: 88.3639 },
      addressText: 'Ballygunge, Kolkata',
    },
    {
      name: 'Vikram Das (Demo)',
      email: 'tech.plumbing@smartpool.demo',
      phone: '+91-9000000202',
      categories: ['plumbing'],
      zoneCode: 'KOL-EAST-SL2',
      coords: { lat: 22.5867, lng: 88.4171 },
      addressText: 'Salt Lake Sector II, Kolkata',
    },
    {
      name: 'Arjun Ghosh (Demo)',
      email: 'tech.electrical@smartpool.demo',
      phone: '+91-9000000203',
      categories: ['electrical', 'home-cleaning'],
      zoneCode: 'KOL-SOUTH-GP',
      coords: { lat: 22.5015, lng: 88.3531 },
      addressText: 'Green Park / Jadavpur, Kolkata',
    },
  ];

  for (const t of demoTechnicians) {
    const user = await upsertUser({
      name: t.name,
      email: t.email,
      phone: t.phone,
      password: 'TechDemo123!',
      role: 'technician',
    });

    const catIds = t.categories.map((slug) => categoryMap.get(slug)._id);
    const zone = zoneMap.get(t.zoneCode);
    await TechnicianProfile.findOneAndUpdate(
      { userId: user._id },
      {
        $setOnInsert: {
          userId: user._id,
          serviceCategories: catIds,
          zoneId: zone?._id || null,
          baseLocation: toGeoJSONPoint(t.coords.lat, t.coords.lng),
          addressText: t.addressText,
          serviceRadiusKm: 10,
          maxPoolCapacity: 4,
          availabilityStatus: 'available',
          approvalStatus: 'approved',
        },
      },
      { upsert: true, new: true }
    );
  }

  console.log(
    'Seed completed successfully (5 categories, 3 service zones, 1 admin, 3 customers, 3 approved technicians).'
  );
  await disconnectDB();
}

seed().catch(async (err) => {
  console.error('Seed failed:', err);
  await disconnectDB();
  process.exit(1);
});

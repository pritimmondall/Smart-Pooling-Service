import { AppError } from '../../utils/appError.js';

export const poolScopes = {
  building: { label: 'Apartment area (100 m)', capacity: 10, radiusKm: 0.1 },
  '200m': { label: '200 m', capacity: 6, radiusKm: 0.2 },
  '500m': { label: '500 m', capacity: 4, radiusKm: 0.5 },
  '1km': { label: '1 km', capacity: 2, radiusKm: 1 },
};

const catalog = {
  'ac-service': ['Electrical & appliances', ['AC service']],
  'appliance-repair': ['Electrical & appliances', ['Fridge repair', 'TV repair', 'Washing machine repair', 'Microwave repair']],
  electrical: ['Electrical & appliances', ['Switchboard repair', 'Fan installation', 'Wiring repair']],
  plumbing: ['Plumbing', ['Tap repair', 'Water leak repair', 'Drain cleaning']],
  'home-cleaning': ['Cleaning', ['Bathroom cleaning', 'Kitchen cleaning', 'Room cleaning']],
};

export function serviceOptions(category) {
  const [domain, services] = catalog[category.slug] || [category.name, [category.name]];
  return { domain, services };
}

export function buildingKey(value) {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 160) : '';
}

export function getScope(key) {
  if (!Object.hasOwn(poolScopes, key)) throw new AppError(400, 'Choose a valid pool area.', 'INVALID_SCOPE');
  return poolScopes[key];
}

export function scheduledWindow(category, capacity) {
  // Leave a joining period before the existing dispatch cutoff.
  const start = new Date(Date.now() + ((category.poolLockCutoffMins || 60) + 30) * 60000);
  return { start, end: new Date(+start + capacity * (category.estimatedDurationMins + 15) * 60000) };
}

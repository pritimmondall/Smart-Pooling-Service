/**
 * Route Metrics Formatting Utilities
 *
 * Safely formats numeric routing metrics supporting canonical { value, unit } objects,
 * direct numbers, and legacy property structures ({ km }, { minutes }).
 * Correctly preserves zero values (e.g. 0 km, 0 mins), missing/null values ('N/A'),
 * and normalizes unit labels (e.g. 'minutes' -> 'mins').
 */

export function formatRouteMetric(metric, defaultUnit = '') {
  if (metric === null || metric === undefined) return 'N/A';

  // Direct primitive number
  if (typeof metric === 'number') {
    const formatted = Number.isInteger(metric) ? metric : Number(metric.toFixed(2));
    return `${formatted} ${defaultUnit}`.trim();
  }

  // Canonical backend format: { value: <number>, unit: <string> }
  if (metric.value !== undefined && metric.value !== null) {
    const val = metric.value;
    const formatted =
      typeof val === 'number'
        ? Number.isInteger(val)
          ? val
          : Number(val.toFixed(2))
        : val;
    let unit = metric.unit || defaultUnit;
    if (unit === 'minutes') unit = 'mins';
    return `${formatted} ${unit}`.trim();
  }

  // Fallbacks for alternative/legacy formats (.km, .minutes)
  if (metric.km !== undefined && metric.km !== null) {
    const formatted =
      typeof metric.km === 'number'
        ? Number.isInteger(metric.km)
          ? metric.km
          : Number(metric.km.toFixed(2))
        : metric.km;
    return `${formatted} km`;
  }

  if (metric.minutes !== undefined && metric.minutes !== null) {
    const formatted =
      typeof metric.minutes === 'number'
        ? Number.isInteger(metric.minutes)
          ? metric.minutes
          : Number(metric.minutes.toFixed(2))
        : metric.minutes;
    return `${formatted} mins`;
  }

  return 'N/A';
}

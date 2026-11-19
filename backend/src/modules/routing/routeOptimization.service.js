import { getDefaultRoutingProvider } from './routingProvider.factory.js';
import { RoutingProviderError } from './providers/baseRoutingProvider.js';
import { validateCoordinates, fromGeoJSONPoint } from '../../utils/geo.js';

/**
 * Generates all permutations of an array.
 * Used for exact branch-and-bound TSP with Time Windows (TSPTW) when N <= 8.
 */
function permute(arr) {
  if (arr.length <= 1) return [arr];
  const result = [];
  for (let i = 0; i < arr.length; i++) {
    const current = arr[i];
    const remaining = arr.slice(0, i).concat(arr.slice(i + 1));
    const subPerms = permute(remaining);
    for (const sub of subPerms) {
      result.push([current, ...sub]);
    }
  }
  return result;
}

/**
 * Evaluates a specific stop sequence permutation against road network metrics and time windows.
 */
function evaluateTour(permutation, durations, distances, stops, departureTime) {
  let currentTime = new Date(departureTime).getTime();
  let currentNode = 0; // 0 = technician starting point
  let totalTravelSeconds = 0;
  let totalDistanceMeters = 0;
  let totalWaitSeconds = 0;
  let timeWindowViolations = 0;

  const evaluatedStops = [];
  const conflicts = [];

  for (let idx = 0; idx < permutation.length; idx++) {
    const stopIndex = permutation[idx];
    const stop = stops[stopIndex - 1]; // 1-based index in matrix, 0-based in stops array

    const legDurationSec = durations[currentNode][stopIndex];
    const legDistanceMeters = distances[currentNode][stopIndex];

    const arrivalTimeMs = currentTime + legDurationSec * 1000;
    const arrivalDate = new Date(arrivalTimeMs);

    const windowStartMs = new Date(stop.timeWindow.start).getTime();
    const windowEndMs = new Date(stop.timeWindow.end).getTime();

    // Check if arrival is before window start (technician must wait)
    let waitMs = 0;
    let serviceStartMs = arrivalTimeMs;
    if (arrivalTimeMs < windowStartMs) {
      waitMs = windowStartMs - arrivalTimeMs;
      serviceStartMs = windowStartMs;
    }

    // Check if arrival is after window end (infeasible time window)
    const isFeasible = arrivalTimeMs <= windowEndMs;
    if (!isFeasible) {
      timeWindowViolations += 1;
      const delayMins = Math.ceil((arrivalTimeMs - windowEndMs) / 60000);
      conflicts.push({
        bookingId: stop.bookingId,
        customerName: stop.customerName,
        customerPhone: stop.customerPhone,
        addressText: stop.addressText,
        timeWindow: {
          start: new Date(windowStartMs).toISOString(),
          end: new Date(windowEndMs).toISOString(),
        },
        estimatedArrival: arrivalDate.toISOString(),
        delayMinutes: delayMins,
        conflictDescription: `Estimated arrival at ${arrivalDate.toISOString()} is ${delayMins} min(s) past window end (${new Date(
          windowEndMs
        ).toISOString()}).`,
      });
    }

    const durationMins = stop.estimatedDurationMins || 45;
    const serviceEndMs = serviceStartMs + durationMins * 60 * 1000;

    evaluatedStops.push({
      sequenceIndex: idx + 1,
      bookingId: stop.bookingId,
      customerId: stop.customerId,
      customerName: stop.customerName,
      customerPhone: stop.customerPhone,
      addressText: stop.addressText,
      location: stop.location,
      timeWindow: {
        start: new Date(windowStartMs).toISOString(),
        end: new Date(windowEndMs).toISOString(),
      },
      estimatedArrival: arrivalDate.toISOString(),
      estimatedServiceStart: new Date(serviceStartMs).toISOString(),
      estimatedServiceEnd: new Date(serviceEndMs).toISOString(),
      estimatedTravelFromPrevious: {
        distanceMeters: legDistanceMeters,
        distanceKm: Number((legDistanceMeters / 1000).toFixed(2)),
        durationSeconds: legDurationSec,
        durationMinutes: Number((legDurationSec / 60).toFixed(1)),
        waitingMinutes: Number((waitMs / 60000).toFixed(1)),
      },
      isTimeWindowFeasible: isFeasible,
    });

    totalTravelSeconds += legDurationSec;
    totalDistanceMeters += legDistanceMeters;
    totalWaitSeconds += Math.round(waitMs / 1000);
    currentTime = serviceEndMs;
    currentNode = stopIndex;
  }

  return {
    evaluatedStops,
    conflicts,
    timeWindowViolations,
    totalTravelSeconds,
    totalDistanceMeters,
    totalWaitSeconds,
    score: timeWindowViolations * 1000000 + totalTravelSeconds + totalWaitSeconds * 0.5,
  };
}

/**
 * Exact Branch-and-Bound with Bounding and Pruning for TSPTW (N <= 8).
 *
 * Dynamically explores partial paths and prunes any branch whose accumulated score
 * (violations * 1e6 + travelSeconds + waitSeconds * 0.5) is already >= the current best upper bound.
 *
 * Mathematically guarantees finding the optimal tour that minimizes
 * window violations and total road travel time for N <= 8.
 */
function optimizeBranchAndBound(stops, durations, distances, departureTime) {
  const n = stops.length;
  let bestScore = Infinity;
  let bestTour = null;

  function search(currentPath, remainingSet, currentTime, currentNode, travelSeconds, distanceMeters, waitSeconds, violations) {
    const currentScore = violations * 1000000 + travelSeconds + waitSeconds * 0.5;

    // Prune branch if partial path score is already >= best complete tour found
    if (currentScore >= bestScore) {
      return;
    }

    // Base case: all stops visited
    if (remainingSet.size === 0) {
      bestScore = currentScore;
      bestTour = evaluateTour(currentPath, durations, distances, stops, departureTime);
      return;
    }

    // Branching: order candidates by travel duration from currentNode for early tight upper bound
    const candidates = Array.from(remainingSet);
    candidates.sort((a, b) => durations[currentNode][a] - durations[currentNode][b]);

    for (const nextNode of candidates) {
      const legDuration = durations[currentNode][nextNode];
      const legDistance = distances[currentNode][nextNode];
      const arrivalMs = currentTime + legDuration * 1000;
      const stop = stops[nextNode - 1];

      const windowStartMs = new Date(stop.timeWindow.start).getTime();
      const windowEndMs = new Date(stop.timeWindow.end).getTime();

      let nextWaitMs = 0;
      let serviceStartMs = arrivalMs;
      if (arrivalMs < windowStartMs) {
        nextWaitMs = windowStartMs - arrivalMs;
        serviceStartMs = windowStartMs;
      }

      let nextViolations = violations;
      if (arrivalMs > windowEndMs) {
        nextViolations += 1;
      }

      const durationMins = stop.estimatedDurationMins || 45;
      const serviceEndMs = serviceStartMs + durationMins * 60 * 1000;

      const nextRemaining = new Set(remainingSet);
      nextRemaining.delete(nextNode);

      search(
        [...currentPath, nextNode],
        nextRemaining,
        serviceEndMs,
        nextNode,
        travelSeconds + legDuration,
        distanceMeters + legDistance,
        waitSeconds + Math.round(nextWaitMs / 1000),
        nextViolations
      );
    }
  }

  const initialRemaining = new Set(Array.from({ length: n }, (_, i) => i + 1));
  const startTime = new Date(departureTime).getTime();

  search([], initialRemaining, startTime, 0, 0, 0, 0, 0);

  return {
    bestTour,
    algorithm: 'branch_and_bound_exact',
    isGloballyOptimal: Boolean(bestTour && bestTour.timeWindowViolations === 0),
  };
}

/**
 * Greedy Nearest-Neighbor with 2-Opt Local Search Heuristic (N > 8).
 */
function optimizeHeuristicNearestNeighbor2Opt(stops, durations, distances, departureTime) {
  const n = stops.length;
  const unvisited = new Set(Array.from({ length: n }, (_, i) => i + 1));
  let currentNode = 0;
  const tour = [];

  // Greedy Nearest Neighbor pass
  while (unvisited.size > 0) {
    let nearestNode = null;
    let minTime = Infinity;

    for (const node of unvisited) {
      const travelTime = durations[currentNode][node];
      if (travelTime < minTime) {
        minTime = travelTime;
        nearestNode = node;
      }
    }

    tour.push(nearestNode);
    unvisited.delete(nearestNode);
    currentNode = nearestNode;
  }

  // 2-Opt Local Search pass
  let improved = true;
  let bestTourEvaluation = evaluateTour(tour, durations, distances, stops, departureTime);

  while (improved) {
    improved = false;
    for (let i = 0; i < tour.length - 1; i++) {
      for (let k = i + 1; k < tour.length; k++) {
        const candidate = [
          ...tour.slice(0, i),
          ...tour.slice(i, k + 1).reverse(),
          ...tour.slice(k + 1),
        ];
        const evalCandidate = evaluateTour(candidate, durations, distances, stops, departureTime);
        if (evalCandidate.score < bestTourEvaluation.score) {
          tour.splice(0, tour.length, ...candidate);
          bestTourEvaluation = evalCandidate;
          improved = true;
        }
      }
    }
  }

  return {
    bestTour: bestTourEvaluation,
    algorithm: 'nearest_neighbor_2opt',
    isGloballyOptimal: false,
  };
}

/**
 * Core Route Optimization Service.
 *
 * Optimizes the stop sequence for an assigned pooled job using real road-network driving metrics.
 *
 * @param {Object} params
 * @param {{ lat: number, lng: number } | Object} params.technicianStartLocation - Technician base or current location
 * @param {Array<Object>} params.stops - Array of member bookings
 * @param {Date} [params.departureTime] - Start of the trip
 * @param {import('./providers/baseRoutingProvider.js').BaseRoutingProvider} [params.routingProvider] - Routing provider override
 * @returns {Promise<Object>}
 */
export async function optimizePoolRoute({
  technicianStartLocation,
  stops,
  departureTime = new Date(),
  routingProvider = null,
  preserveOrder = false,
} = {}) {
  const provider = routingProvider || getDefaultRoutingProvider();

  // Validate starting coordinates
  let startCoords;
  try {
    const raw =
      technicianStartLocation?.type === 'Point'
        ? fromGeoJSONPoint(technicianStartLocation)
        : technicianStartLocation;
    startCoords = validateCoordinates(raw?.lat, raw?.lng);
  } catch (err) {
    throw new RoutingProviderError(
      `Invalid technician start coordinates: ${err.message}`,
      'INVALID_COORDINATES',
      err
    );
  }

  // If no stops, return empty optimized route
  if (!Array.isArray(stops) || stops.length === 0) {
    return {
      optimizationStatus: 'no_stops',
      provider: provider.name,
      algorithm: 'none',
      roadDistanceCalculated: true,
      totalTravelDistance: { value: 0, unit: 'km', meters: 0 },
      totalTravelTime: { value: 0, unit: 'minutes', seconds: 0 },
      totalServiceDuration: { value: 0, unit: 'minutes' },
      totalTripDuration: { value: 0, unit: 'minutes' },
      departureTime: new Date(departureTime).toISOString(),
      stops: [],
      schedulingConflicts: [],
      limitations: 'No stops provided for optimization.',
    };
  }

  // Prepare normalized stop data
  const normalizedStops = stops.map((s, idx) => {
    let stopCoords;
    const rawLoc = s.location?.type === 'Point' ? fromGeoJSONPoint(s.location) : s.location;
    try {
      stopCoords = validateCoordinates(rawLoc?.lat, rawLoc?.lng);
    } catch (err) {
      throw new RoutingProviderError(
        `Invalid coordinates for stop #${idx + 1} (${s.bookingId || s._id}): ${err.message}`,
        'INVALID_COORDINATES',
        err
      );
    }

    return {
      bookingId: s.bookingId || s._id,
      customerId: s.customerId?._id || s.customerId,
      customerName: s.customerId?.name || s.customerName || 'Customer',
      customerPhone: s.customerId?.phone || s.customerPhone || 'N/A',
      addressText: s.addressText || '',
      location: stopCoords,
      timeWindow: s.timeWindow || {
        start: new Date(departureTime),
        end: new Date(new Date(departureTime).getTime() + 4 * 3600000),
      },
      estimatedDurationMins: s.estimatedDurationMins || 45,
    };
  });

  // Construct coordinate list: Node 0 = Start, Node 1..N = Stops
  const allCoordinates = [startCoords, ...normalizedStops.map((s) => s.location)];

  let matrix;
  try {
    matrix = await provider.getDistanceMatrix(allCoordinates);
  } catch (err) {
    // Road routing provider is unavailable or timed out.
    // As required: Do NOT silently present straight-line distance as road distance.
    // Return explicit fallback status rather than claiming an optimized road route!
    console.warn(`[Routing Warning] Road provider "${provider.name}" failed: ${err.message}. Returning fallback status.`);

    const totalServiceMinutes = normalizedStops.reduce((sum, s) => sum + (s.estimatedDurationMins || 45), 0);

    return {
      optimizationStatus: 'provider_unavailable',
      provider: provider.name,
      algorithm: 'none',
      roadDistanceCalculated: false,
      errorMessage: `Road routing provider is currently unavailable (${err.message}). Straight-line distance was not substituted for road driving metrics.`,
      departureTime: new Date(departureTime).toISOString(),
      totalTravelDistance: null,
      totalTravelTime: null,
      totalServiceDuration: { value: totalServiceMinutes, unit: 'minutes' },
      totalTripDuration: null,
      stops: normalizedStops.map((s, i) => ({
        sequenceIndex: i + 1,
        bookingId: s.bookingId,
        customerId: s.customerId,
        customerName: s.customerName,
        customerPhone: s.customerPhone,
        addressText: s.addressText,
        location: s.location,
        timeWindow: {
          start: new Date(s.timeWindow.start).toISOString(),
          end: new Date(s.timeWindow.end).toISOString(),
        },
        estimatedArrival: null,
        estimatedServiceStart: null,
        estimatedServiceEnd: null,
        estimatedTravelFromPrevious: null,
        isTimeWindowFeasible: null,
      })),
      schedulingConflicts: [],
      limitations: 'Road network routing provider failed or timed out. Stops retain original sequence.',
    };
  }

  // Optimize tour using exact branch-and-bound with pruning (N <= 8) or heuristic (N > 8)
  const optimizationResult = preserveOrder ? {
    bestTour: evaluateTour(normalizedStops.map((_, i) => i + 1), matrix.durations, matrix.distances, normalizedStops, departureTime),
    algorithm: 'booking_order', isGloballyOptimal: false,
  } : normalizedStops.length <= 8
      ? optimizeBranchAndBound(normalizedStops, matrix.durations, matrix.distances, departureTime)
      : optimizeHeuristicNearestNeighbor2Opt(normalizedStops, matrix.durations, matrix.distances, departureTime);

  const { bestTour, algorithm, isGloballyOptimal } = optimizationResult;

  const totalServiceMinutes = normalizedStops.reduce((sum, s) => sum + (s.estimatedDurationMins || 45), 0);
  const totalTravelMinutes = Number((bestTour.totalTravelSeconds / 60).toFixed(1));
  const totalTripMinutes = Number((totalTravelMinutes + totalServiceMinutes + bestTour.totalWaitSeconds / 60).toFixed(1));

  let finalStatus = 'optimal_road_network';
  if (bestTour.timeWindowViolations > 0) {
    finalStatus = 'infeasible_time_windows';
  } else if (!isGloballyOptimal) {
    finalStatus = 'heuristic_road_network';
  }

  const isMockProvider = matrix.provider === 'mock';
  const measurementType = isMockProvider ? 'simulated_road_network' : 'actual_road_network';

  return {
    optimizationStatus: finalStatus,
    provider: matrix.provider,
    separateDispatchMeters: matrix.distances[0].slice(1).reduce((sum, meters) => sum + meters, 0),
    algorithm,
    measurementType,
    isGloballyOptimal: Boolean(isGloballyOptimal && bestTour.timeWindowViolations === 0),
    roadDistanceCalculated: true,
    departureTime: new Date(departureTime).toISOString(),
    technicianStartLocation: startCoords,
    totalTravelDistance: {
      value: Number((bestTour.totalDistanceMeters / 1000).toFixed(2)),
      unit: 'km',
      meters: bestTour.totalDistanceMeters,
    },
    totalTravelTime: {
      value: totalTravelMinutes,
      unit: 'minutes',
      seconds: bestTour.totalTravelSeconds,
    },
    totalServiceDuration: {
      value: totalServiceMinutes,
      unit: 'minutes',
    },
    totalTripDuration: {
      value: totalTripMinutes,
      unit: 'minutes',
    },
    stops: bestTour.evaluatedStops,
    schedulingConflicts: bestTour.conflicts,
    limitations: isMockProvider
      ? 'Distances and travel times are simulated using an urban road tortuosity factor (1.35x) and 30 km/h average speed. Not measured on live road traffic.'
      : 'Road distances and travel times are based on road-network topology and average driving speeds; actual field travel times may vary based on live traffic, weather, parking availability, and on-site job delays.',
  };
}

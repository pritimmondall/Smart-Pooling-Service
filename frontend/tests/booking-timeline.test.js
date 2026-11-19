import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOOKING_STATUS_PROGRESSION,
  STATUS_LABELS,
  getTimelineStepIndex,
  isStepPassed,
  isStepCurrent,
  getBookingTimelineState,
} from '../src/utils/bookingTimeline.js';
import { bookingsApi } from '../src/api/client.js';

describe('Customer Booking Timeline Suite (DEF-04 Remediation)', () => {
  it('1. correctly maps pending booking status to stage 0 and keeps future stages inactive', () => {
    const state = getBookingTimelineState('pending');

    assert.equal(state.isCancelled, false);
    assert.equal(state.isUnknown, false);
    assert.equal(state.currentStepIndex, 0);
    assert.equal(state.currentLabel, 'Pending Matching');
    assert.equal(state.steps.length, 7);

    // Step 0 ('pending') is passed and current
    assert.equal(state.steps[0].key, 'pending');
    assert.equal(state.steps[0].isPassed, true);
    assert.equal(state.steps[0].isCurrent, true);
    assert.equal(state.steps[0].isFuture, false);

    // All subsequent steps (1 through 6) must remain strictly inactive / future
    for (let i = 1; i < state.steps.length; i++) {
      assert.equal(state.steps[i].isPassed, false, `Step ${i} (${state.steps[i].key}) must not be passed`);
      assert.equal(state.steps[i].isCurrent, false, `Step ${i} (${state.steps[i].key}) must not be current`);
      assert.equal(state.steps[i].isFuture, true, `Step ${i} (${state.steps[i].key}) must be marked future`);
    }
  });

  it('2. correctly maps accepted booking status to stage 3, activating prior stages and keeping later stages inactive', () => {
    const state = getBookingTimelineState('accepted');

    assert.equal(state.isCancelled, false);
    assert.equal(state.isUnknown, false);
    assert.equal(state.currentStepIndex, 3);
    assert.equal(state.currentLabel, 'Accepted');

    // Prior stages (pending, confirmed, assigned) and accepted must be passed
    const passedKeys = ['pending', 'confirmed', 'assigned', 'accepted'];
    passedKeys.forEach((key, idx) => {
      assert.equal(state.steps[idx].key, key);
      assert.equal(state.steps[idx].isPassed, true, `${key} must be marked as passed for accepted booking`);
    });

    // Step 3 ('accepted') must be the active current stage
    assert.equal(state.steps[3].isCurrent, true, 'accepted must be marked as current');
    assert.equal(state.steps[3].isFuture, false);

    // Later stages (arrived, in_progress, completed) must be strictly inactive / future
    const futureKeys = ['arrived', 'in_progress', 'completed'];
    futureKeys.forEach((key, offset) => {
      const idx = 4 + offset;
      assert.equal(state.steps[idx].key, key);
      assert.equal(state.steps[idx].isPassed, false, `${key} must NOT be passed for accepted booking`);
      assert.equal(state.steps[idx].isCurrent, false, `${key} must NOT be current for accepted booking`);
      assert.equal(state.steps[idx].isFuture, true, `${key} must be future`);
    });
  });

  it('3. correctly maps arrived booking status to stage 4, confirming on-site arrival', () => {
    const state = getBookingTimelineState('arrived');

    assert.equal(state.isCancelled, false);
    assert.equal(state.isUnknown, false);
    assert.equal(state.currentStepIndex, 4);
    assert.equal(state.currentLabel, 'Arrived');

    // Steps 0 through 4 (pending, confirmed, assigned, accepted, arrived) are passed
    for (let i = 0; i <= 4; i++) {
      assert.equal(state.steps[i].isPassed, true, `Step ${i} (${state.steps[i].key}) must be passed`);
    }

    // Step 4 ('arrived') must be current
    assert.equal(state.steps[4].isCurrent, true);
    assert.equal(state.steps[4].isFuture, false);

    // Steps 5 ('in_progress') and 6 ('completed') must remain strictly inactive
    assert.equal(state.steps[5].isPassed, false, 'in_progress must not be passed');
    assert.equal(state.steps[5].isCurrent, false);
    assert.equal(state.steps[5].isFuture, true);

    assert.equal(state.steps[6].isPassed, false, 'completed must not be passed');
    assert.equal(state.steps[6].isCurrent, false);
    assert.equal(state.steps[6].isFuture, true);
  });

  it('4. correctly maps in-progress booking status to stage 5, confirming active service delivery', () => {
    const state = getBookingTimelineState('in_progress');

    assert.equal(state.isCancelled, false);
    assert.equal(state.isUnknown, false);
    assert.equal(state.currentStepIndex, 5);
    assert.equal(state.currentLabel, 'In Progress');

    // Steps 0 through 5 are passed
    for (let i = 0; i <= 5; i++) {
      assert.equal(state.steps[i].isPassed, true, `Step ${i} (${state.steps[i].key}) must be passed`);
    }

    // Step 5 ('in_progress') is current
    assert.equal(state.steps[5].isCurrent, true);
    assert.equal(state.steps[5].isFuture, false);

    // Final step 6 ('completed') remains inactive
    assert.equal(state.steps[6].isPassed, false);
    assert.equal(state.steps[6].isCurrent, false);
    assert.equal(state.steps[6].isFuture, true);
  });

  it('5. correctly maps completed booking status to stage 6, verifying 100% completion across all steps', () => {
    const state = getBookingTimelineState('completed');

    assert.equal(state.isCancelled, false);
    assert.equal(state.isUnknown, false);
    assert.equal(state.currentStepIndex, 6);
    assert.equal(state.currentLabel, 'Completed');
    assert.equal(state.completionPercentage, 100);

    // Every step must be passed
    state.steps.forEach((step, idx) => {
      assert.equal(step.isPassed, true, `Step ${idx} (${step.key}) must be passed`);
      assert.equal(step.isFuture, false, `Step ${idx} (${step.key}) must not be future`);
    });

    // Step 6 ('completed') is the current final terminal stage
    assert.equal(state.steps[6].isCurrent, true);
  });

  it('6. correctly presents cancelled booking with dedicated cancelled flag, never presenting as completed', () => {
    const state = getBookingTimelineState('cancelled');

    assert.equal(state.isCancelled, true, 'isCancelled must be true');
    assert.equal(state.isUnknown, false);
    assert.equal(state.currentStepIndex, -1, 'currentStepIndex must be -1 for cancelled');
    assert.equal(state.currentLabel, 'Cancelled');
    assert.equal(state.completionPercentage, 0, 'Cancelled bookings must have 0% progression');

    // Cancelled bookings must NOT mark any standard step as passed or current
    state.steps.forEach((step, idx) => {
      assert.equal(step.isPassed, false, `Step ${idx} must not be passed when cancelled`);
      assert.equal(step.isCurrent, false, `Step ${idx} must not be current when cancelled`);
    });
  });

  it('7. safely handles unknown, null, undefined, or unsupported statuses without throwing', () => {
    const testCases = ['unknown_state', 'invalid', '', null, undefined, 12345];

    for (const input of testCases) {
      assert.doesNotThrow(() => {
        const state = getBookingTimelineState(input);
        assert.equal(state.isCancelled, false);
        assert.equal(state.isUnknown, true, `Status "${input}" must be marked unknown`);
        assert.equal(state.currentStepIndex, -1);
        assert.equal(state.completionPercentage, 0);

        // No steps should be passed or current
        state.steps.forEach((s) => {
          assert.equal(s.isPassed, false);
          assert.equal(s.isCurrent, false);
        });
      });
    }
  });

  it('8. verifies strict monotonic progression between consecutive lifecycle stages', () => {
    const sequence = [
      'pending',
      'confirmed',
      'assigned',
      'accepted',
      'arrived',
      'in_progress',
      'completed',
    ];

    let prevIndex = -1;
    let prevPercentage = -1;

    for (const status of sequence) {
      const state = getBookingTimelineState(status);
      assert.ok(
        state.currentStepIndex > prevIndex,
        `Index for ${status} (${state.currentStepIndex}) must be strictly greater than previous (${prevIndex})`
      );
      assert.ok(
        state.completionPercentage > prevPercentage,
        `Completion percentage for ${status} (${state.completionPercentage}%) must exceed previous (${prevPercentage}%)`
      );
      prevIndex = state.currentStepIndex;
      prevPercentage = state.completionPercentage;
    }
  });

  it('9. guarantees that future stages are never accidentally activated for intermediate states', () => {
    // For every state, ensure no step with index > currentStepIndex is active
    for (let currentIdx = 0; currentIdx < BOOKING_STATUS_PROGRESSION.length; currentIdx++) {
      const status = BOOKING_STATUS_PROGRESSION[currentIdx];
      const state = getBookingTimelineState(status);

      state.steps.forEach((step, stepIdx) => {
        if (stepIdx > currentIdx) {
          assert.equal(
            step.isPassed,
            false,
            `Stage ${step.key} (index ${stepIdx}) must not be passed when booking is in "${status}" (index ${currentIdx})`
          );
          assert.equal(
            step.isCurrent,
            false,
            `Stage ${step.key} (index ${stepIdx}) must not be current when booking is in "${status}" (index ${currentIdx})`
          );
          assert.equal(
            step.isFuture,
            true,
            `Stage ${step.key} (index ${stepIdx}) must be future when booking is in "${status}" (index ${currentIdx})`
          );
        }
      });
    }
  });

  it('10. verifies timeline mapping after loading a real booking API response payload structure', async () => {
    // Real backend GET /api/v1/bookings/:id response structure
    const mockApiResponse = {
      success: true,
      data: {
        _id: '6afe16111111111111111111',
        bookingMode: 'pool',
        status: 'arrived',
        price: 1080,
        estimatedPrice: 1080,
        addressText: 'Block CD, Sector 1, Salt Lake, Kolkata',
        timeWindow: {
          start: '2026-11-19T05:00:00.000Z',
          end: '2026-11-19T07:00:00.000Z',
        },
        serviceCategoryId: {
          _id: 'cat-123',
          name: 'AC Deep Service',
        },
        zoneId: {
          _id: 'zone-123',
          name: 'Salt Lake Zone',
        },
        technicianId: {
          _id: 'tech-123',
          name: 'Rahul Sen',
        },
      },
    };

    globalThis.fetch = async () => ({
      ok: true,
      text: async () => JSON.stringify(mockApiResponse),
    });

    const res = await bookingsApi.getById('6afe16111111111111111111');
    const booking = res.data;

    assert.equal(booking.status, 'arrived');
    const timeline = getBookingTimelineState(booking.status);

    assert.equal(timeline.isCancelled, false);
    assert.equal(timeline.currentStepIndex, 4);
    assert.equal(timeline.currentLabel, 'Arrived');
    assert.equal(timeline.steps[4].isCurrent, true);
    assert.equal(timeline.steps[3].isPassed, true, 'accepted must be passed when arrived');
    assert.equal(timeline.steps[5].isPassed, false, 'in_progress must not be passed when arrived');
  });
});

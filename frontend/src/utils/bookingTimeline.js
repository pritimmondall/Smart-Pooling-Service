/**
 * Customer Booking Timeline Mapping & Progression Utilities (DEF-04)
 *
 * Maps canonical backend booking statuses to user-facing service fulfillment stages.
 * Supports all backend booking lifecycle states:
 * - pending: Initial request creation, awaiting matching/pool lock
 * - confirmed: Pool formed / booking confirmed
 * - assigned: Technician dispatched/assigned to pool or job
 * - accepted: Technician explicitly accepted the job assignment
 * - arrived: Technician arrived at the customer's service location
 * - in_progress: Service execution actively underway
 * - completed: Service completed and verified
 * - cancelled: Terminal cancellation
 */

export const BOOKING_STATUS_PROGRESSION = [
  'pending',
  'confirmed',
  'assigned',
  'accepted',
  'arrived',
  'in_progress',
  'completed',
];

export const STATUS_LABELS = {
  pending: 'Pending Matching',
  confirmed: 'Confirmed',
  assigned: 'Assigned',
  accepted: 'Accepted',
  arrived: 'Arrived',
  in_progress: 'In Progress',
  completed: 'Completed',
};

/**
 * Returns the zero-based sequence index for a given lifecycle status.
 * Returns -1 if the status is cancelled, invalid, or unrecognized.
 *
 * @param {string} status
 * @returns {number}
 */
export function getTimelineStepIndex(status) {
  if (!status || typeof status !== 'string') return -1;
  return BOOKING_STATUS_PROGRESSION.indexOf(status);
}

/**
 * Evaluates whether a timeline stage index has been passed/completed by the current booking status.
 *
 * @param {string} currentStatus
 * @param {number} stepIndex
 * @returns {boolean}
 */
export function isStepPassed(currentStatus, stepIndex) {
  if (!currentStatus || currentStatus === 'cancelled') return false;
  const currentIndex = getTimelineStepIndex(currentStatus);
  return currentIndex !== -1 && currentIndex >= stepIndex;
}

/**
 * Evaluates whether a timeline stage index is the active/current stage for the current booking status.
 *
 * @param {string} currentStatus
 * @param {number} stepIndex
 * @returns {boolean}
 */
export function isStepCurrent(currentStatus, stepIndex) {
  if (!currentStatus || currentStatus === 'cancelled') return false;
  const currentIndex = getTimelineStepIndex(currentStatus);
  return currentIndex !== -1 && currentIndex === stepIndex;
}

/**
 * Returns complete timeline rendering metadata for a booking status.
 *
 * @param {string} status
 * @returns {{
 *   isCancelled: boolean,
 *   isUnknown: boolean,
 *   currentStepIndex: number,
 *   currentStatus: string,
 *   currentLabel: string,
 *   steps: Array<{ key: string, label: string, index: number, isPassed: boolean, isCurrent: boolean, isFuture: boolean }>,
 *   completionPercentage: number
 * }}
 */
export function getBookingTimelineState(status) {
  const isCancelled = status === 'cancelled';
  const currentStepIndex = getTimelineStepIndex(status);
  const isUnknown = !isCancelled && currentStepIndex === -1;

  let currentLabel = 'Unknown';
  if (isCancelled) {
    currentLabel = 'Cancelled';
  } else if (currentStepIndex !== -1) {
    currentLabel = STATUS_LABELS[status] || status;
  }

  const steps = BOOKING_STATUS_PROGRESSION.map((key, index) => {
    const passed = currentStepIndex !== -1 && currentStepIndex >= index && !isCancelled;
    const current = currentStepIndex !== -1 && currentStepIndex === index && !isCancelled;
    const future = (currentStepIndex === -1 || currentStepIndex < index) && !isCancelled;

    return {
      key,
      label: STATUS_LABELS[key] || key,
      index,
      isPassed: passed,
      isCurrent: current,
      isFuture: future,
    };
  });

  const completionPercentage =
    isCancelled || isUnknown || currentStepIndex === -1
      ? 0
      : Math.round(((currentStepIndex + 1) / BOOKING_STATUS_PROGRESSION.length) * 100);

  return {
    isCancelled,
    isUnknown,
    currentStepIndex,
    currentStatus: status,
    currentLabel,
    steps,
    completionPercentage,
  };
}

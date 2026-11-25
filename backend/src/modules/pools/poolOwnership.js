// Matching creates the pool with its founder as the first member and appends subsequent joins.
export function canEditPoolCutoff(pool, customerId) {
  const memberId = member => String(member.customerId?._id || member.customerId);
  return !pool.automaticDispatch && pool.status === 'forming' && pool.lockCutoffTime > new Date() && pool.members.length > 0 &&
    memberId(pool.members[0]) === String(customerId) &&
    pool.members.some(member => member.status === 'active' && memberId(member) === String(customerId));
}

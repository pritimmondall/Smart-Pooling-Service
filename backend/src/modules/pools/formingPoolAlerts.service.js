import { Notification, ServicePool, TechnicianProfile, User } from '../../models/index.js';

export async function notifyTechniciansOfNewPool(pool, serviceName, session) {
  // Claim delivery inside the same transaction as the inbox inserts.
  const claimed = await ServicePool.updateOne({
    _id: pool._id, status: 'forming', formingAlertsSent: { $ne: true },
  }, { $set: { formingAlertsSent: true } }, { session });
  if (!claimed.modifiedCount) return;

  const technicians = await TechnicianProfile.find({
    serviceCategories: pool.serviceCategoryId._id || pool.serviceCategoryId,
    approvalStatus: 'approved',
  }).distinct('userId').session(session);
  const users = await User.find({ _id: { $in: technicians }, role: 'technician', isActive: true })
    .select('_id').session(session).lean();
  if (users.length) {
    await Notification.insertMany(users.map(user => ({
      userId: user._id, role: 'technician', type: 'pool', relatedEntityId: pool._id,
      title: 'New service pool',
      message: `A ${serviceName} pool is forming. You can reserve it now while customers continue joining.`,
    })), { session, ordered: true });
  }
}

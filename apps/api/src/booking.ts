import { DateTime } from 'luxon';
import { Types, type ClientSession } from 'mongoose';
import { config } from './config.js';
import { assert, transaction } from './db.js';
import { availability, buckets, QUANTUM } from './availability.js';
import { AuditEvent, Notification, Occupancy, PaymentAttempt, PaymentEvent, RefundRecord, Reservation, ReservationHold, Resource } from './models.js';
import { provider, type VerifiedEvent } from './payments.js';
export async function audit(entityId: string, action: string, actorId: string, detail: string, session: ClientSession) { await AuditEvent.create([{ entityId, action, actorId, detail }], { session }); }
async function notify(userId: Types.ObjectId, key: string, subject: string, text: string, session: ClientSession) { await Notification.updateOne({ dedupeKey: key }, { $setOnInsert: { userId, subject, text } }, { upsert: true, session }); }
export async function expireHold(id: string, session?: ClientSession): Promise<boolean> {
 const work = async (s: ClientSession) => {
  const hold = await ReservationHold.findOneAndUpdate({ _id: id, state: 'active', expiresAt: { $lte: new Date() } }, { $set: { state: 'expired' } }, { session: s, new: true });
  if (!hold) return false;
  await Occupancy.deleteMany({ holdId: hold._id }, { session: s });
  await audit(id, 'hold.expired', 'system', 'Occupancy released', s);
  return true;
 };
 return session ? work(session) : transaction(work);
}
export async function createHold(userId: string, resourceId: string, startISO: string, duration: number) {
 try { return await transaction(async session => {
  // Serialize configuration and hold creation on this resource; the unique occupancy index is the final invariant.
  const resource = await Resource.findByIdAndUpdate(resourceId, { $inc: { revision: 1 } }, { session, new: true });
  assert(resource, 404, 'Resource not found');
  const now = new Date(); const start = new Date(startISO); const end = new Date(+start + duration * 60_000);
  assert(Number.isFinite(+start) && +start % QUANTUM === 0, 400, 'Start must align to a 15-minute UTC boundary');
  const stale = await ReservationHold.find({ resourceId, state: 'active', expiresAt: { $lte: now } }).session(session);
  for (const hold of stale) await expireHold(String(hold._id), session);
  const date = DateTime.fromJSDate(start, { zone: resource.timeZone }).toISODate()!;
  const available = await availability(resourceId, date, duration, now, session);
  assert(available.slots.some(s => s.start === start.toISOString()), 409, 'This time is no longer available');
  const [hold] = await ReservationHold.create([{ resourceId, userId, start, end, timeZone: resource.timeZone, amount: Math.round(available.amount), currency: resource.currency, cancellationHours: resource.cancellationHours, expiresAt: new Date(+now + config.holdSeconds * 1000) }], { session });
  await Occupancy.insertMany(buckets(start, end).map(bucket => ({ resourceId, bucket, holdId: hold._id })), { session });
  await audit(String(hold._id), 'hold.created', userId, `${start.toISOString()} to ${end.toISOString()}`, session);
  return hold;
 }); } catch (error: any) { if (error.code === 11000) throw Object.assign(new Error('This time is no longer available'), { status: 409 }); throw error; }
}
export async function beginPayment(userId: string, holdId: string) {
 const hold = await ReservationHold.findOne({ _id: holdId, userId });
 assert(hold, 404, 'Hold not found');
 assert(hold.state === 'active' && +hold.expiresAt > Date.now(), 409, 'Hold is expired or already consumed');
 let attempt;
 try { attempt = await PaymentAttempt.findOneAndUpdate({ holdId }, { $setOnInsert: { holdId, userId, amount: hold.amount, currency: hold.currency, provider: config.provider } }, { upsert: true, new: true }); }
 catch (error: any) { if (error.code !== 11000) throw error; attempt = await PaymentAttempt.findOne({ holdId }); }
 assert(attempt, 500, 'Could not create payment');
 if (!attempt.providerId) {
  const checkout = await provider(attempt.provider).checkout({ attemptId: String(attempt._id), holdId, amount: attempt.amount, currency: attempt.currency });
  await PaymentAttempt.updateOne({ _id: attempt._id }, { $set: checkout });
  attempt = (await PaymentAttempt.findById(attempt._id))!;
 }
 return attempt;
}
export async function storePaymentEvent(event: VerifiedEvent) {
 try { return await PaymentEvent.findOneAndUpdate({ provider: event.provider, eventId: event.eventId }, { $setOnInsert: event }, { upsert: true, new: true }); }
 catch (error: any) { if (error.code !== 11000) throw error; return PaymentEvent.findOne({ provider: event.provider, eventId: event.eventId }); }
}
export async function processPaymentEvent(id: string) {
 return transaction(async session => {
  const event = await PaymentEvent.findOne({ _id: id, status: 'pending' }).session(session);
  if (!event) return;
  const attempt = await PaymentAttempt.findById(event.attemptId).session(session);
  assert(attempt?.providerId, 503, 'Payment setup not yet persisted; retry event');
  if (attempt.provider !== event.provider || attempt.providerId !== event.providerId || attempt.amount !== event.amount || attempt.currency !== event.currency) {
   event.status = 'rejected'; event.error = 'Provider, amount, or currency mismatch'; await event.save({ session });
   await audit(String(attempt.holdId), 'payment.rejected', 'system', event.error, session); return;
  }
  if (attempt.status === 'pending') {
   const now = new Date();
   const hold = await ReservationHold.findOneAndUpdate({ _id: attempt.holdId, userId: attempt.userId, state: 'active', expiresAt: { $gt: now } }, { $set: { state: 'consumed' } }, { session, new: true });
   if (hold) {
    const owned = await Occupancy.countDocuments({ holdId: hold._id }).session(session);
    assert(owned === buckets(hold.start, hold.end).length, 500, 'Occupancy invariant violated');
    const [booking] = await Reservation.create([{ holdId: hold._id, userId: hold.userId, resourceId: hold.resourceId, start: hold.start, end: hold.end, timeZone: hold.timeZone, amount: hold.amount, currency: hold.currency, cancellationHours: hold.cancellationHours }], { session });
    attempt.status = 'paid';
    await audit(String(hold._id), 'reservation.confirmed', 'system', `Verified provider event ${event.eventId}`, session);
    await notify(hold.userId, `confirmed_${booking._id}`, 'Your Roomly booking is confirmed', `Reservation ${booking._id}\n${hold.start.toISOString()}\nTime zone: ${hold.timeZone}`, session);
   } else {
    await expireHold(String(attempt.holdId), session);
    attempt.status = 'refund_pending';
    await RefundRecord.updateOne({ attemptId: attempt._id }, { $setOnInsert: { amount: attempt.amount, reason: 'Payment received after hold expiry' } }, { upsert: true, session });
    await audit(String(attempt.holdId), 'payment.late', 'system', 'No reservation created. Automatic refund queued.', session);
    await notify(attempt.userId, `late_${attempt._id}`, 'Your hold expired', 'Payment arrived after the hold expired. Your payment is being refunded.', session);
   }
   await attempt.save({ session });
  }
  event.status = 'processed'; event.processedAt = new Date(); await event.save({ session });
 });
}
export async function cancelReservation(userId: string, id: string) {
 return transaction(async session => {
  const booking = await Reservation.findOne({ _id: id, userId }).session(session);
  assert(booking, 404, 'Booking not found');
  if (booking.status === 'cancelled') return booking;
  assert(Date.now() <= +booking.start - booking.cancellationHours * 3600_000, 409, 'The cancellation window has closed');
  booking.status = 'cancelled'; booking.paymentStatus = 'refund_pending'; booking.cancelledAt = new Date();
  await booking.save({ session });
  await Occupancy.deleteMany({ holdId: booking.holdId }, { session });
  const attempt = await PaymentAttempt.findOneAndUpdate({ holdId: booking.holdId, status: 'paid' }, { $set: { status: 'refund_pending' } }, { new: true, session });
  assert(attempt, 409, 'Payment is not eligible for cancellation');
  await RefundRecord.updateOne({ attemptId: attempt._id }, { $setOnInsert: { reservationId: booking._id, amount: booking.amount, reason: 'Customer cancellation' } }, { session, upsert: true });
  await audit(String(booking.holdId), 'reservation.cancelled', userId, 'Occupancy released; refund queued', session);
  await notify(booking.userId, `cancelled_${id}`, 'Your Roomly booking is cancelled', `Reservation ${id} is cancelled. Your refund is being processed.`, session);
  return booking;
 });
}
export async function processRefund(id: string) {
 const refund = await RefundRecord.findOne({ _id: id, status: 'pending' });
 if (!refund) return;
 const attempt = await PaymentAttempt.findById(refund.attemptId);
 assert(attempt?.providerId, 503, 'Payment is missing provider reference');
 const providerRefundId = await provider(attempt.provider).refund(attempt.providerId, refund.amount, String(refund._id));
 await transaction(async session => {
  const changed = await RefundRecord.findOneAndUpdate({ _id: id, status: 'pending' }, { $set: { status: 'succeeded', providerRefundId } }, { session, new: true });
  if (!changed) return;
  await PaymentAttempt.updateOne({ _id: attempt._id }, { $set: { status: 'refunded' } }, { session });
  if (refund.reservationId) await Reservation.updateOne({ _id: refund.reservationId }, { $set: { paymentStatus: 'refunded' } }, { session });
  await audit(String(attempt.holdId), 'refund.succeeded', 'system', providerRefundId, session);
  await notify(attempt.userId, `refunded_${id}`, 'Your Roomly refund is complete', `Refund of ${(refund.amount / 100).toFixed(2)} ${attempt.currency.toUpperCase()} has completed.`, session);
 });
}

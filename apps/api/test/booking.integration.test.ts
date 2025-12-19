import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { app } from '../src/app.js';
import { config } from '../src/config.js';
import { availability } from '../src/availability.js';
import { beginPayment, cancelReservation, createHold, expireHold, processPaymentEvent, processRefund, storePaymentEvent } from '../src/booking.js';
import { AuditEvent, AvailabilityException, AvailabilityRule, initModels, Notification, Occupancy, PaymentAttempt, PaymentEvent, RefundRecord, Reservation, ReservationHold, Resource, User, Venue } from '../src/models.js';
import { signMock } from '../src/payments.js';
let repl: MongoMemoryReplSet | undefined;
let uid: string, otherId: string, adminId: string, rid: string, venueId: string;
let start: string, date: string;
const cookie = (userId: string) => `roomly_session=${jwt.sign({}, config.jwt, { subject: userId, issuer: 'roomly', audience: 'roomly-web', expiresIn: '1h' })}`;
const post = (url: string, userId = uid) => request(app).post(url).set('Cookie', cookie(userId)).set('x-roomly-client', 'web');
async function payable() { const hold = await createHold(uid, rid, start, 60); const attempt = await beginPayment(uid, String(hold._id)); return { hold, attempt }; }
async function eventFor(attempt: any, eventId = `evt_${attempt._id}`) { return (await storePaymentEvent({ provider: 'mock', eventId, attemptId: String(attempt._id), providerId: attempt.providerId, amount: attempt.amount, currency: attempt.currency }))!; }
async function confirmed() { const { hold, attempt } = await payable(); const event = await eventFor(attempt); await processPaymentEvent(String(event._id)); return { hold, attempt, booking: (await Reservation.findOne({ holdId: hold._id }))! }; }
beforeAll(async () => {
 const uri = process.env.TEST_MONGO_URL || (repl = await MongoMemoryReplSet.create({ replSet: { count: 1 }, binary: { version: '7.0.14' } })).getUri();
 await mongoose.connect(uri, { dbName: `roomly_test_${process.pid}` }); await initModels();
});
afterAll(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); await repl?.stop(); });
beforeEach(async () => {
 vi.restoreAllMocks();
 await Promise.all(Object.values(mongoose.models).map(m => m.deleteMany({})));
 const users = await User.create([{ name: 'Customer', email: 'customer@test.local', role: 'customer', passwordHash: await bcrypt.hash('SafePassword123!', 4) }, { name: 'Other', email: 'other@test.local', role: 'customer', passwordHash: 'unused' }, { name: 'Admin', email: 'admin@test.local', role: 'venue-admin', passwordHash: 'unused' }]);
 [uid, otherId, adminId] = users.map(u => String(u._id));
 const venue = await Venue.create({ name: 'Test venue', adminId }); venueId = String(venue._id);
 const resource = await Resource.create({ venueId, name: 'Test room', capacity: 8, hourlyRate: 6000, timeZone: 'America/New_York', durations: [30, 60, 90, 120], cancellationHours: 24 }); rid = String(resource._id);
 await AvailabilityRule.insertMany(Array.from({ length: 7 }, (_, i) => ({ resourceId: rid, weekday: i + 1, startMinute: 0, endMinute: 1440 })));
 const future = new Date(); future.setUTCDate(future.getUTCDate() + 3); future.setUTCHours(15, 0, 0, 0); start = future.toISOString(); date = start.slice(0, 10);
});
describe('database-backed reservations', () => {
 it('24 concurrent HTTP booking flows produce exactly one successful confirmation', async () => {
  const results = await Promise.all(Array.from({ length: 24 }, async () => {
   const response = await post('/api/holds').send({ resourceId: rid, start, duration: 60 });
   if (response.status !== 201) return response.status;
   const payment = await post(`/api/holds/${response.body._id}/payment`).send({}); expect(payment.status).toBe(200);
   const complete = await post(`/api/payments/${payment.body._id}/mock-complete`).send({}); expect(complete.status).toBe(202);
   const event = await PaymentEvent.findOne({ attemptId: payment.body._id }); await processPaymentEvent(String(event!._id));
   const booking = await Reservation.findOne({ holdId: response.body._id }); expect(booking?.status).toBe('confirmed'); return 201;
  }));
  expect(results.filter(s => s === 201)).toHaveLength(1); expect(results.filter(s => s === 409)).toHaveLength(23);
  expect(await Reservation.countDocuments()).toBe(1); expect(await Occupancy.countDocuments()).toBe(4);
  const indexes = await Occupancy.collection.indexes(); expect(indexes.find(i => i.name === 'resourceId_1_bucket_1')?.unique).toBe(true);
 });
 it('blocks partial overlaps for variable durations but allows adjacent intervals', async () => {
  await createHold(uid, rid, start, 90);
  await expect(createHold(otherId, rid, new Date(+new Date(start) + 60 * 60000).toISOString(), 60)).rejects.toMatchObject({ status: 409 });
  await expect(createHold(otherId, rid, new Date(+new Date(start) + 90 * 60000).toISOString(), 30)).resolves.toBeTruthy();
 });
 it('ignores client price/availability assertions and enforces duration and alignment', async () => {
  const response = await post('/api/holds').send({ resourceId: rid, start, duration: 60, amount: 1, available: true }); expect(response.status).toBe(201); expect(response.body.amount).toBe(6000);
  expect((await post('/api/holds').send({ resourceId: rid, start, duration: 17 })).status).toBe(400);
  expect((await post('/api/holds').send({ resourceId: rid, start: new Date(+new Date(start) + 1000).toISOString(), duration: 60 })).status).toBe(400);
 });
 it('reclaims expired holds during acquisition even when the expiration worker is down', async () => {
  const first = await createHold(uid, rid, start, 60); await ReservationHold.updateOne({ _id: first._id }, { expiresAt: new Date(Date.now() - 1000) });
  const slots = await availability(rid, date, 60); expect(slots.slots.some(s => s.start === start)).toBe(true);
  const second = await createHold(otherId, rid, start, 60); expect(String(second._id)).not.toBe(String(first._id)); expect((await ReservationHold.findById(first._id))?.state).toBe('expired');
  expect(await Occupancy.countDocuments({ holdId: second._id })).toBe(4);
 });
 it('expiry racing with a late payment and a new hold never consumes the new owner’s occupancy', async () => {
  const { hold, attempt } = await payable(); const event = await eventFor(attempt);
  await ReservationHold.updateOne({ _id: hold._id }, { expiresAt: new Date(Date.now() - 1) });
  const [, , replacement] = await Promise.all([expireHold(String(hold._id)), processPaymentEvent(String(event._id)), createHold(otherId, rid, start, 60)]);
  expect(await Reservation.countDocuments()).toBe(0); expect(await Occupancy.countDocuments({ holdId: replacement._id })).toBe(4);
  expect(await RefundRecord.countDocuments({ attemptId: attempt._id })).toBe(1);
 });
 it('confirmation wins before expiration, and later expiry cannot release its occupancy', async () => {
  const { hold, attempt } = await payable(); const event = await eventFor(attempt);
  await Promise.all([expireHold(String(hold._id)), processPaymentEvent(String(event._id))]);
  await ReservationHold.updateOne({ _id: hold._id }, { expiresAt: new Date(Date.now() - 1) }); expect(await expireHold(String(hold._id))).toBe(false);
  expect(await Reservation.countDocuments()).toBe(1); expect(await Occupancy.countDocuments()).toBe(4);
 });
 it('consumes a hold at most once across replayed and distinct payment event IDs', async () => {
  const { hold, attempt } = await payable();
  const events = await Promise.all(Array.from({ length: 8 }, (_, i) => eventFor(attempt, `event_${i % 2}`)));
  await Promise.all(events.map(e => processPaymentEvent(String(e._id))));
  expect(await PaymentEvent.countDocuments()).toBe(2); expect(await Reservation.countDocuments({ holdId: hold._id })).toBe(1);
  expect(await Notification.countDocuments()).toBe(1); expect(await AuditEvent.countDocuments({ action: 'reservation.confirmed' })).toBe(1);
  await expect(beginPayment(uid, String(hold._id))).rejects.toMatchObject({ status: 409 });
 });
 it('handles the webhook before browser redirect; reads never mark a reservation paid', async () => {
  const { hold, attempt } = await payable();
  expect((await request(app).get(`/api/holds/${hold._id}?returned=1`).set('Cookie', cookie(uid))).body.reservation).toBeNull();
  const raw = JSON.stringify({ eventId: 'before_redirect', attemptId: String(attempt._id), providerId: attempt.providerId, amount: attempt.amount, currency: attempt.currency });
  const response = await request(app).post('/api/webhooks/mock').set('content-type', 'application/json').set('x-mock-signature', signMock(raw)).send(raw); expect(response.status).toBe(202);
  await processPaymentEvent(String((await PaymentEvent.findOne({ eventId: 'before_redirect' }))!._id));
  const page = await request(app).get(`/api/holds/${hold._id}`).set('Cookie', cookie(uid)); expect(page.body.reservation.paymentStatus).toBe('paid');
 });
 it('rejects invalid or stale signatures and signed amount mismatches', async () => {
  const { attempt } = await payable(); const raw = JSON.stringify({ eventId: 'bad', attemptId: String(attempt._id), providerId: attempt.providerId, amount: 1, currency: 'usd' });
  for (const signature of ['bad', signMock(raw, Math.floor(Date.now() / 1000) - 600), signMock(raw + ' ')]) {
   const response = await request(app).post('/api/webhooks/mock').set('content-type', 'application/json').set('x-mock-signature', signature).send(raw); expect(response.status).toBe(400);
  }
  expect(await PaymentEvent.countDocuments()).toBe(0);
  await request(app).post('/api/webhooks/mock').set('content-type', 'application/json').set('x-mock-signature', signMock(raw)).send(raw);
  const event = (await PaymentEvent.findOne())!; await processPaymentEvent(String(event._id));
  expect((await PaymentEvent.findById(event._id))?.status).toBe('rejected'); expect(await Reservation.countDocuments()).toBe(0);
 });
 it('creates one refund on repeated cancellations and replays, and releases availability', async () => {
  const { attempt, booking } = await confirmed();
  await Promise.all(Array.from({ length: 6 }, () => cancelReservation(uid, String(booking._id))));
  const replay = await eventFor(attempt, 'after_cancel'); await processPaymentEvent(String(replay._id));
  const refund = (await RefundRecord.findOne())!; await Promise.all([processRefund(String(refund._id)), processRefund(String(refund._id))]);
  expect(await RefundRecord.countDocuments()).toBe(1); expect((await RefundRecord.findById(refund._id))?.status).toBe('succeeded');
  expect((await Reservation.findById(booking._id))?.paymentStatus).toBe('refunded'); expect(await Occupancy.countDocuments()).toBe(0);
  expect(await AuditEvent.countDocuments({ action: 'refund.succeeded' })).toBe(1);
  expect((await availability(rid, date, 60)).slots.some(s => s.start === start)).toBe(true);
 });
 it('accepts cancellation exactly at the cutoff and rejects one millisecond later', async () => {
  const { booking } = await confirmed(); const cutoff = +booking.start - booking.cancellationHours * 3600000;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(cutoff + 1);
  await expect(cancelReservation(uid, String(booking._id))).rejects.toMatchObject({ status: 409 });
  clock.mockReturnValue(cutoff); await expect(cancelReservation(uid, String(booking._id))).resolves.toMatchObject({ status: 'cancelled' }); clock.mockRestore();
 });
 it('refunds late payment only once even when events arrive repeatedly', async () => {
  const { hold, attempt } = await payable(); await ReservationHold.updateOne({ _id: hold._id }, { expiresAt: new Date(0) });
  const events = await Promise.all([eventFor(attempt, 'late1'), eventFor(attempt, 'late2')]); await Promise.all(events.map(e => processPaymentEvent(String(e._id))));
  expect(await RefundRecord.countDocuments()).toBe(1); const refund = (await RefundRecord.findOne())!; await processRefund(String(refund._id)); await processPaymentEvent(String(events[0]._id));
  expect(await Reservation.countDocuments()).toBe(0); expect(await RefundRecord.countDocuments()).toBe(1); expect(await Occupancy.countDocuments()).toBe(0);
 });
 it('blocks holds on blackout dates', async () => {
  await AvailabilityException.create({ resourceId: rid, date, reason: 'Maintenance' });
  expect((await availability(rid, date, 60)).slots).toHaveLength(0);
  await expect(createHold(uid, rid, start, 60)).rejects.toMatchObject({ status: 409 });
 });
});
describe('authentication and authorization', () => {
 it('uses an httpOnly cookie and forbids self-registration as admin', async () => {
  const login = await post('/api/auth/login').send({ email: 'customer@test.local', password: 'SafePassword123!' }); expect(login.status).toBe(200); expect(login.headers['set-cookie'][0]).toContain('HttpOnly'); expect(login.body.passwordHash).toBeUndefined();
  const register = await post('/api/auth/register').send({ name: 'Mallory', email: 'new@test.local', password: 'SafePassword123!', role: 'venue-admin' }); expect(register.body.role).toBe('customer');
 });
 it('rejects anonymous requests, missing CSRF headers, and hostile origins', async () => {
  expect((await request(app).post('/api/holds').set('x-roomly-client', 'web').send({})).status).toBe(401);
  expect((await request(app).post('/api/holds').set('Cookie', cookie(uid)).send({})).status).toBe(403);
  expect((await post('/api/holds').set('origin', 'https://evil.example').send({})).status).toBe(403);
 });
 it('enforces hold ownership and booking ownership', async () => {
  const { hold, attempt } = await payable();
  expect((await post(`/api/holds/${hold._id}/payment`, otherId).send({})).status).toBe(404);
  expect((await post(`/api/payments/${attempt._id}/mock-complete`, otherId).send({})).status).toBe(404);
  const event = await eventFor(attempt); await processPaymentEvent(String(event._id)); const booking = (await Reservation.findOne())!;
  expect((await post(`/api/bookings/${booking._id}/cancel`, otherId).send({})).status).toBe(404);
 });
 it('restricts admin data and configuration to assigned venues', async () => {
  expect((await request(app).get('/api/admin/resources').set('Cookie', cookie(uid))).status).toBe(403);
  const own = await request(app).get('/api/admin/resources').set('Cookie', cookie(adminId)); expect(own.body.resources).toHaveLength(1);
  const stranger = await User.create({ name: 'Other admin', email: 'admin2@test.local', passwordHash: 'unused', role: 'venue-admin' });
  const other = await request(app).get('/api/admin/resources').set('Cookie', cookie(String(stranger._id))); expect(other.body.resources).toHaveLength(0);
  const body = { venueId, name: 'Hijack', description: '', kind: 'Meeting room', capacity: 4, timeZone: 'UTC', hourlyRate: 5000, cancellationHours: 24, durations: [60], amenities: [], rules: [], exceptions: [] };
  const result = await request(app).put(`/api/admin/resources/${rid}`).set('Cookie', cookie(String(stranger._id))).set('x-roomly-client', 'web').send(body); expect(result.status).toBe(403);
 });
});

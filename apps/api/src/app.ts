import express, { type Request, type Response, type NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { IANAZone } from 'luxon';
import { config } from './config.js';
import { assert, transaction } from './db.js';
import { availability } from './availability.js';
import { audit, beginPayment, cancelReservation, createHold, storePaymentEvent } from './booking.js';
import { provider, signMock } from './payments.js';
import { AuditEvent, AvailabilityException, AvailabilityRule, PaymentAttempt, RefundRecord, Reservation, ReservationHold, Resource, User, Venue } from './models.js';
declare global { namespace Express { interface Request { user?: { id: string; role: string; name: string; email: string } } } }
const id = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid ID');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const app = express();
app.disable('x-powered-by'); app.use(helmet());
app.post('/api/webhooks/:provider', express.raw({ type: 'application/json', limit: '64kb' }), async (req, res) => {
 assert(req.params.provider === config.provider, 400, 'Payment provider is disabled');
 const adapter = provider(req.params.provider);
 const event = adapter.verify(req.body, req.get(adapter.name === 'stripe' ? 'stripe-signature' : 'x-mock-signature') || '');
 if (event) await storePaymentEvent(event);
 // A persisted inbox is acknowledged even if Redis is unavailable. The worker reconciles it.
 res.status(202).json({ received: true });
});
app.use(express.json({ limit: '32kb' })); app.use(cookieParser());
app.use('/api', rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false }));
app.use('/api', (req, _res, next) => {
 if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
  assert(req.get('x-roomly-client') === 'web', 403, 'Missing CSRF request header');
  assert(!req.get('origin') || req.get('origin') === config.appUrl, 403, 'Origin is not allowed');
 }
 next();
});
const authLimit = rateLimit({ windowMs: 15 * 60_000, limit: process.env.NODE_ENV === 'test' ? 200 : 30 });
function sessionCookie(res: Response, user: { _id: unknown }) {
 res.cookie('roomly_session', jwt.sign({}, config.jwt, { subject: String(user._id), expiresIn: '8h', issuer: 'roomly', audience: 'roomly-web' }), { httpOnly: true, sameSite: 'lax', secure: config.production, maxAge: 8 * 3600_000, path: '/' });
}
const publicUser = (u: any) => ({ id: String(u._id), name: u.name, email: u.email, role: u.role });
async function auth(req: Request, _res: Response, next: NextFunction) {
 try {
  const payload = jwt.verify(req.cookies.roomly_session || '', config.jwt, { issuer: 'roomly', audience: 'roomly-web', algorithms: ['HS256'] });
  assert(typeof payload !== 'string' && payload.sub, 401, 'Please sign in');
  const user = await User.findById(payload.sub); assert(user, 401, 'Please sign in'); req.user = publicUser(user);
 } catch { throw Object.assign(new Error('Please sign in'), { status: 401 }); }
 next();
}
function admin(req: Request, _res: Response, next: NextFunction) { assert(req.user?.role === 'venue-admin', 403, 'Venue administrator access required'); next(); }
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
app.post('/api/auth/register', authLimit, async (req, res) => {
 const body = z.object({ name: z.string().trim().min(2).max(80), email: z.email().max(254).transform(s => s.toLowerCase()), password: z.string().min(12).max(100) }).parse(req.body);
 const user = await User.create({ name: body.name, email: body.email, passwordHash: await bcrypt.hash(body.password, 12), role: 'customer' }); sessionCookie(res, user); res.status(201).json(publicUser(user));
});
app.post('/api/auth/login', authLimit, async (req, res) => {
 const body = z.object({ email: z.email().transform(s => s.toLowerCase()), password: z.string().max(100) }).parse(req.body);
 const user = await User.findOne({ email: body.email }).select('+passwordHash');
 const match = await bcrypt.compare(body.password, user?.passwordHash || '$2b$12$skvRqBI.fYrvZXazRhCvRuOr3dv2A/obqeM8dq4FuUayRz/LwlROO');
 assert(user && match, 401, 'Email or password is incorrect'); sessionCookie(res, user); res.json(publicUser(user));
});
app.post('/api/auth/logout', (_req, res) => { res.clearCookie('roomly_session', { path: '/' }); res.json({ ok: true }); });
app.get('/api/auth/me', auth, (req, res) => res.json(req.user));
app.get('/api/venues', async (_req, res) => res.json(await Venue.find().select('-adminId').limit(100).lean()));
app.get('/api/resources', async (req, res) => {
 const q = z.object({ venue: id.optional(), capacity: z.coerce.number().int().min(1).max(1000).optional() }).parse(req.query);
 res.json(await Resource.find({ ...(q.venue ? { venueId: q.venue } : {}), ...(q.capacity ? { capacity: { $gte: q.capacity } } : {}) }).populate('venueId', 'name city address').limit(100).lean());
});
app.get('/api/resources/:id/availability', async (req, res) => {
 const q = z.object({ date, duration: z.coerce.number().int().min(15).max(480) }).parse(req.query);
 res.json(await availability(id.parse(req.params.id), q.date, q.duration));
});
app.post('/api/holds', auth, async (req, res) => {
 const body = z.object({ resourceId: id, start: z.iso.datetime({ offset: true }), duration: z.number().int().min(15).max(480) }).parse(req.body);
 res.status(201).json(await createHold(req.user!.id, body.resourceId, body.start, body.duration));
});
app.get('/api/holds/:id', auth, async (req, res) => {
 const hold = await ReservationHold.findOne({ _id: id.parse(req.params.id), userId: req.user!.id }).populate('resourceId'); assert(hold, 404, 'Hold not found');
 const reservation = await Reservation.findOne({ holdId: hold._id }); const payment = await PaymentAttempt.findOne({ holdId: hold._id });
 res.json({ hold, reservation, payment, serverNow: new Date().toISOString() });
});
app.post('/api/holds/:id/payment', auth, async (req, res) => res.json(await beginPayment(req.user!.id, id.parse(req.params.id))));
app.post('/api/payments/:id/mock-complete', auth, async (req, res) => {
 assert(config.provider === 'mock', 404, 'Mock payments are disabled');
 const attempt = await PaymentAttempt.findOne({ _id: id.parse(req.params.id), userId: req.user!.id, provider: 'mock' }); assert(attempt?.providerId, 404, 'Payment not found');
 const hold = await ReservationHold.findOne({ _id: attempt.holdId, userId: req.user!.id });
 assert(hold && hold.state === 'active' && +hold.expiresAt > Date.now(), 409, 'This hold has expired or has already been paid');
 const raw = JSON.stringify({ eventId: `mock_success_${attempt._id}`, attemptId: String(attempt._id), providerId: attempt.providerId, amount: attempt.amount, currency: attempt.currency });
 const verified = provider('mock').verify(Buffer.from(raw), signMock(raw))!;
 await storePaymentEvent(verified); res.status(202).json({ status: 'processing' });
});
app.get('/api/bookings', auth, async (req, res) => res.json(await Reservation.find({ userId: req.user!.id }).sort({ start: -1 }).populate('resourceId').limit(200).lean()));
app.get('/api/bookings/:id', auth, async (req, res) => {
 const booking = await Reservation.findOne({ _id: id.parse(req.params.id), userId: req.user!.id }).populate('resourceId'); assert(booking, 404, 'Booking not found');
 const timeline = await AuditEvent.find({ entityId: String(booking.holdId) }).sort({ createdAt: 1 }).lean();
 const refund = await RefundRecord.findOne({ reservationId: booking._id }); res.json({ booking, timeline, refund });
});
app.post('/api/bookings/:id/cancel', auth, async (req, res) => res.json(await cancelReservation(req.user!.id, id.parse(req.params.id))));
app.use('/api/admin', auth, admin);
app.get('/api/admin/resources', async (req, res) => {
 const venues = await Venue.find({ adminId: req.user!.id }).lean(); const resources = await Resource.find({ venueId: { $in: venues.map(v => v._id) } }).populate('venueId').lean();
 const ids = resources.map(r => r._id);
 res.json({ venues, resources, rules: await AvailabilityRule.find({ resourceId: { $in: ids } }).lean(), exceptions: await AvailabilityException.find({ resourceId: { $in: ids } }).lean() });
});
app.post('/api/admin/venues', async (req, res) => {
 const body = z.object({ name: z.string().trim().min(2).max(100), address: z.string().max(200), city: z.string().max(100) }).parse(req.body);
 res.status(201).json(await Venue.create({ ...body, adminId: req.user!.id }));
});
const resourceSchema = z.object({
 venueId: id, name: z.string().trim().min(2).max(100), description: z.string().max(1000), kind: z.enum(['Meeting room', 'Coworking', 'Studio']),
 capacity: z.number().int().min(1).max(1000), timeZone: z.string().refine(IANAZone.isValidZone, 'Use an IANA time zone'),
 hourlyRate: z.number().int().min(100).max(1000000), cancellationHours: z.number().int().min(0).max(720),
 durations: z.array(z.number().int().min(15).max(480).refine(v => v % 15 === 0)).min(1).max(32), amenities: z.array(z.string().max(50)).max(12),
 rules: z.array(z.object({ weekday: z.number().int().min(1).max(7), startMinute: z.number().int().min(0).max(1425).multipleOf(15), endMinute: z.number().int().min(15).max(1440).multipleOf(15) }).refine(r => r.endMinute > r.startMinute)).max(28),
 exceptions: z.array(z.object({ date, reason: z.string().max(200) })).max(366)
});
async function saveResource(req: Request, res: Response) {
 const body = resourceSchema.parse(req.body); const resourceId = req.params.id ? id.parse(req.params.id) : undefined;
 const result = await transaction(async session => {
  const venue = await Venue.findOne({ _id: body.venueId, adminId: req.user!.id }).session(session); assert(venue, 403, 'You do not administer this venue');
  const { rules, exceptions, ...data } = body;
  let resource;
  if (resourceId) {
   const previous = await Resource.findById(resourceId).session(session); assert(previous, 404, 'Resource not found');
   const owned = await Venue.exists({ _id: previous.venueId, adminId: req.user!.id }).session(session); assert(owned, 403, 'You do not administer this resource');
   resource = await Resource.findByIdAndUpdate(resourceId, { $set: data, $inc: { revision: 1 } }, { session, new: true });
  } else [resource] = await Resource.create([data], { session });
  assert(resource, 500, 'Could not save resource');
  await AvailabilityRule.deleteMany({ resourceId: resource._id }, { session });
  await AvailabilityException.deleteMany({ resourceId: resource._id }, { session });
  if (rules.length) await AvailabilityRule.insertMany(rules.map(rule => ({ ...rule, resourceId: resource._id })), { session });
  if (exceptions.length) await AvailabilityException.insertMany(exceptions.map(exception => ({ ...exception, resourceId: resource._id })), { session });
  await audit(String(resource._id), 'resource.updated', req.user!.id, 'Availability configuration saved. Existing holds and bookings retain their policy snapshots.', session);
  return resource;
 }); res.status(resourceId ? 200 : 201).json(result);
}
app.post('/api/admin/resources', saveResource); app.put('/api/admin/resources/:id', saveResource);
app.get('/api/admin/schedule', async (req, res) => {
 const q = z.object({ from: z.iso.datetime(), to: z.iso.datetime(), resourceId: id.optional(), status: z.enum(['confirmed', 'cancelled']).optional() }).parse(req.query);
 assert(+new Date(q.to) > +new Date(q.from) && +new Date(q.to) - +new Date(q.from) <= 32 * 86400_000, 400, 'Schedule range must be at most 32 days');
 const venues = await Venue.find({ adminId: req.user!.id }); const resources = await Resource.find({ venueId: { $in: venues.map(v => v._id) }, ...(q.resourceId ? { _id: q.resourceId } : {}) });
 const filter = { resourceId: { $in: resources.map(r => r._id) }, start: { $lt: new Date(q.to) }, end: { $gt: new Date(q.from) } };
 const bookings = await Reservation.find({ ...filter, ...(q.status ? { status: q.status } : {}) }).populate('resourceId').populate('userId', 'name email').sort({ start: 1 }).limit(500).lean();
 const holds = await ReservationHold.find({ ...filter, state: 'active', expiresAt: { $gt: new Date() } }).populate('resourceId').populate('userId', 'name email').limit(500).lean();
 const timeline = await AuditEvent.find({ entityId: { $in: [...bookings.map(b => String(b.holdId)), ...holds.map(h => String(h._id)), ...resources.map(r => String(r._id))] } }).sort({ createdAt: -1 }).limit(100).lean();
 res.json({ bookings, holds, timeline });
});
app.use((_req, res) => res.status(404).json({ error: 'Endpoint not found' }));
app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
 const status = error instanceof z.ZodError ? 400 : error.code === 11000 ? 409 : error.name === 'CastError' ? 400 : error.status || 500;
 if (status >= 500) console.error(error.message);
 res.status(status).json({ error: error instanceof z.ZodError ? error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') : status === 500 ? 'An internal error occurred' : error.code === 11000 ? 'This record already exists' : error.message });
});
export { app };

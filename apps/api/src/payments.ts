import { createHmac, timingSafeEqual } from 'node:crypto';
import Stripe from 'stripe';
import { z } from 'zod';
import { config } from './config.js';
import { assert } from './db.js';
export type VerifiedEvent = { provider: string; eventId: string; attemptId: string; providerId: string; amount: number; currency: string };
export interface PaymentProvider {
 name: string;
 checkout(input: { attemptId: string; holdId: string; amount: number; currency: string }): Promise<{ providerId: string; checkoutUrl?: string }>;
 verify(body: Buffer, signature: string): VerifiedEvent | null;
 refund(providerId: string, amount: number, key: string): Promise<string>;
}
const eventSchema = z.object({ eventId: z.string().min(1).max(200), attemptId: z.string().regex(/^[a-f\d]{24}$/i), providerId: z.string().min(1).max(200), amount: z.number().int().positive(), currency: z.literal('usd') });
export function signMock(body: string, timestamp = Math.floor(Date.now() / 1000)) { return `${timestamp}.${createHmac('sha256', config.mockSecret).update(`${timestamp}.${body}`).digest('hex')}`; }
export const mockProvider: PaymentProvider = {
 name: 'mock',
 async checkout(input) { return { providerId: `mock_${input.attemptId}` }; },
 verify(body, signature) {
  const [stamp, received] = signature.split('.');
  assert(/^\d+$/.test(stamp || '') && Math.abs(Date.now() / 1000 - Number(stamp)) <= 300 && /^[a-f\d]{64}$/.test(received || ''), 400, 'Invalid webhook signature');
  const expected = signMock(body.toString(), Number(stamp)).split('.')[1];
  assert(timingSafeEqual(Buffer.from(received, 'hex'), Buffer.from(expected, 'hex')), 400, 'Invalid webhook signature');
  return { provider: 'mock', ...eventSchema.parse(JSON.parse(body.toString())) };
 },
 async refund(providerId, _amount, key) { return `mock_refund_${providerId}_${key}`; }
};
let stripeClient: Stripe | undefined;
function stripe() {
 assert(process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_'), 503, 'Stripe test mode is not configured');
 return stripeClient ||= new Stripe(process.env.STRIPE_SECRET_KEY!);
}
export const stripeProvider: PaymentProvider = {
 name: 'stripe',
 async checkout(input) {
  const result = await stripe().checkout.sessions.create({
   mode: 'payment', payment_method_types: ['card'], client_reference_id: input.attemptId,
   metadata: { attemptId: input.attemptId },
   line_items: [{ price_data: { currency: input.currency, unit_amount: input.amount, product_data: { name: 'Roomly space reservation' } }, quantity: 1 }],
   success_url: `${config.appUrl}/checkout/${input.holdId}?returned=1`, cancel_url: `${config.appUrl}/checkout/${input.holdId}`
  }, { idempotencyKey: `checkout_${input.attemptId}` });
  return { providerId: result.id, checkoutUrl: result.url || undefined };
 },
 verify(body, signature) {
  let event: Stripe.Event;
  try { event = stripe().webhooks.constructEvent(body, signature, process.env.STRIPE_WEBHOOK_SECRET || ''); }
  catch { throw Object.assign(new Error('Invalid webhook signature'), { status: 400 }); }
  assert(!event.livemode, 400, 'Live payments are not supported');
  if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) return null;
  const session = event.data.object as Stripe.Checkout.Session;
  if (session.payment_status !== 'paid') return null;
  return { provider: 'stripe', ...eventSchema.parse({ eventId: event.id, attemptId: session.metadata?.attemptId, providerId: session.id, amount: session.amount_total, currency: session.currency }) };
 },
 async refund(providerId, amount, key) {
  const session = await stripe().checkout.sessions.retrieve(providerId);
  assert(typeof session.payment_intent === 'string', 409, 'Payment intent not available');
  const refund = await stripe().refunds.create({ payment_intent: session.payment_intent, amount }, { idempotencyKey: `refund_${key}` });
  // Keep pending refunds queued; retrieving via the same key yields the same refund.
  assert(refund.status === 'succeeded', 503, 'Refund is not yet successful; retry required');
  return refund.id;
 }
};
export function provider(name = config.provider) { assert(['mock', 'stripe'].includes(name), 400, 'Unknown provider'); return name === 'stripe' ? stripeProvider : mockProvider; }

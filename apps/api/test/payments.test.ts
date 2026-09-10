import { afterEach, describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import { stripeProvider } from '../src/payments.js';
afterEach(() => vi.unstubAllEnvs());
describe('Stripe test adapter signatures', () => {
 it('verifies original bytes and rejects tampered, stale and live events', () => {
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_roomly'); vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_roomly');
  const stripe = new Stripe('sk_test_roomly');
  const payload = { id: 'evt_test', type: 'checkout.session.completed', livemode: false, data: { object: { id: 'cs_test_123', metadata: { attemptId: 'a'.repeat(24) }, amount_total: 6000, currency: 'usd', payment_status: 'paid' } } };
  const raw = JSON.stringify(payload);
  const signature = stripe.webhooks.generateTestHeaderString({ payload: raw, secret: 'whsec_roomly' });
  expect(stripeProvider.verify(Buffer.from(raw), signature)?.amount).toBe(6000);
  expect(() => stripeProvider.verify(Buffer.from(raw + ' '), signature)).toThrow('Invalid webhook signature');
  const stale = stripe.webhooks.generateTestHeaderString({ payload: raw, secret: 'whsec_roomly', timestamp: Math.floor(Date.now() / 1000) - 600 });
  expect(() => stripeProvider.verify(Buffer.from(raw), stale)).toThrow('Invalid webhook signature');
  const live = JSON.stringify({ ...payload, livemode: true });
  expect(() => stripeProvider.verify(Buffer.from(live), stripe.webhooks.generateTestHeaderString({ payload: live, secret: 'whsec_roomly' }))).toThrow('Live payments');
 });
 it('ignores unpaid completion events', () => {
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_roomly'); vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_roomly');
  const raw = JSON.stringify({ id: 'evt_unpaid', type: 'checkout.session.completed', livemode: false, data: { object: { payment_status: 'unpaid' } } });
  const signature = new Stripe('sk_test_roomly').webhooks.generateTestHeaderString({ payload: raw, secret: 'whsec_roomly' });
  expect(stripeProvider.verify(Buffer.from(raw), signature)).toBeNull();
 });
});

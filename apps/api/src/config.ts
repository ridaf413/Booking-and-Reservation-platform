import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });
export const config = {
 port: Number(process.env.PORT || 4000),
 mongo: process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/roomly?replicaSet=rs0&directConnection=true',
 redis: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
 appUrl: process.env.APP_URL || 'http://localhost:5173',
 jwt: process.env.JWT_SECRET || 'local-demo-only-change-this-secret-at-least-32-chars',
 mockSecret: process.env.MOCK_WEBHOOK_SECRET || 'local-mock-webhook-secret-change-me',
 provider: process.env.PAYMENT_PROVIDER || 'mock',
 holdSeconds: Number(process.env.HOLD_SECONDS || 300),
 smtpHost: process.env.SMTP_HOST || '127.0.0.1', smtpPort: Number(process.env.SMTP_PORT || 1025),
 production: process.env.NODE_ENV === 'production'
};
if (!['mock', 'stripe'].includes(config.provider)) throw new Error('Unknown payment provider');
if (config.production && (!process.env.JWT_SECRET || config.jwt.startsWith('local-') || config.jwt.length < 32 || !process.env.MOCK_WEBHOOK_SECRET || config.mockSecret.startsWith('local-'))) throw new Error('Production requires strong, explicit JWT and mock webhook secrets');
if (config.provider === 'stripe' && !process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_')) throw new Error('Only Stripe test keys are supported');

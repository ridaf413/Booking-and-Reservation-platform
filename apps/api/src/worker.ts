import { Queue, Worker } from 'bullmq';
import nodemailer from 'nodemailer';
import mongoose from 'mongoose';
import { config } from './config.js';
import { connect } from './db.js';
import { expireHold, processPaymentEvent, processRefund } from './booking.js';
import { Notification, PaymentEvent, RefundRecord, ReservationHold, User } from './models.js';
await connect();
const url = new URL(config.redis);
const connection = { host: url.hostname, port: Number(url.port || 6379), password: url.password || undefined, username: url.username || undefined, maxRetriesPerRequest: null, ...(url.protocol === 'rediss:' ? { tls: {} } : {}) };
const queue = new Queue('roomly', { connection });
const mailer = nodemailer.createTransport({ host: config.smtpHost, port: config.smtpPort, secure: false });
const worker = new Worker('roomly', async job => {
 if (job.name === 'expire') await expireHold(job.data.id);
 if (job.name === 'payment') await processPaymentEvent(job.data.id);
 if (job.name === 'refund') await processRefund(job.data.id);
 if (job.name === 'email') {
  const message = await Notification.findOneAndUpdate({ _id: job.data.id, $or: [{ status: 'pending' }, { status: 'sending', lockedUntil: { $lte: new Date() } }] }, { $set: { status: 'sending', lockedUntil: new Date(Date.now() + 60_000) } }, { new: true });
  if (!message) return;
  try {
   const user = await User.findById(message.userId); if (!user) throw new Error('Notification recipient not found');
   await mailer.sendMail({ from: 'Roomly <bookings@roomly.local>', to: user.email, subject: message.subject || 'Roomly notification', text: message.text || '', messageId: `<${message._id}@roomly.local>` });
   await Notification.updateOne({ _id: message._id }, { $set: { status: 'sent', sentAt: new Date() } });
  } catch (error) { await Notification.updateOne({ _id: message._id }, { $set: { status: 'pending' } }); throw error; }
 }
}, { connection, concurrency: 8 });
worker.on('failed', (job, error) => console.error(`Job ${job?.name} failed: ${error.message}`));
worker.on('error', error => console.error('Worker error:', error.message));
queue.on('error', error => console.error('Queue error:', error.message));
let reconciling = false;
async function reconcile() {
 if (reconciling) return; reconciling = true;
 try {
  const [holds, events, refunds, emails] = await Promise.all([
   ReservationHold.find({ state: 'active' }).sort({ expiresAt: 1 }).limit(500).lean(),
   PaymentEvent.find({ status: 'pending' }).sort({ createdAt: 1 }).limit(500).lean(),
   RefundRecord.find({ status: 'pending' }).limit(500).lean(),
   Notification.find({ $or: [{ status: 'pending' }, { status: 'sending', lockedUntil: { $lte: new Date() } }] }).limit(500).lean()
  ]);
  const tasks = [...holds.map(h => ({ name: 'expire', id: String(h._id), delay: Math.max(0, +h.expiresAt - Date.now()) })), ...events.map(e => ({ name: 'payment', id: String(e._id), delay: 0 })), ...refunds.map(r => ({ name: 'refund', id: String(r._id), delay: 0 })), ...emails.map(n => ({ name: 'email', id: String(n._id), delay: 0 }))];
  await queue.addBulk(tasks.map(t => ({ name: t.name, data: { id: t.id }, opts: { jobId: `${t.name}_${t.id}`, delay: t.delay, attempts: 5, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: true, removeOnFail: true } })));
 } catch (error) { console.error('Reconciliation failed:', (error as Error).message); }
 finally { reconciling = false; }
}
const timer = setInterval(reconcile, 1000); void reconcile();
console.log('Roomly worker: expiry, payments, refunds and email');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { clearInterval(timer); await worker.close(); await queue.close(); await mongoose.disconnect(); process.exit(0); });

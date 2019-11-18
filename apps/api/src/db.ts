import mongoose, { type ClientSession } from 'mongoose';
import { config } from './config.js';
import { initModels } from './models.js';
export async function connect() { await mongoose.connect(config.mongo); await initModels(); }
export async function transaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
 const session = await mongoose.startSession();
 try { return (await session.withTransaction(() => fn(session), { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } }))!; }
 finally { await session.endSession(); }
}
export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
export function assert(condition: unknown, status: number, message: string): asserts condition { if (!condition) throw new HttpError(status, message); }

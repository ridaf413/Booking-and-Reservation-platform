import { DateTime, IANAZone } from 'luxon';
import type { ClientSession } from 'mongoose';
import { AvailabilityRule, AvailabilityException, Occupancy, ReservationHold, Resource } from './models.js';
import { assert } from './db.js';
export const QUANTUM = 15 * 60_000;
export function buckets(start: Date, end: Date) { const result: Date[] = []; for (let t = +start; t < +end; t += QUANTUM) result.push(new Date(t)); return result; }
export function dayBounds(date: string, zone: string) {
 assert(/^\d{4}-\d{2}-\d{2}$/.test(date) && IANAZone.isValidZone(zone), 400, 'Invalid date or IANA time zone');
 const start = DateTime.fromISO(date, { zone }).startOf('day');
 assert(start.isValid && start.toISODate() === date, 400, 'This local date does not exist in the resource time zone');
 const end = start.plus({ days: 1 }).startOf('day');
 return { start, end, hours: end.diff(start, 'hours').hours };
}
export function candidateSlots(date: string, zone: string, duration: number, rules: { weekday: number; startMinute: number; endMinute: number }[]) {
 const { start, end, hours } = dayBounds(date, zone);
 const slots: { start: string; end: string; label: string; offset: string }[] = [];
 // Enumerate real UTC instants, never construct ambiguous or nonexistent local wall times.
 for (let t = Math.ceil(start.toMillis() / QUANTUM) * QUANTUM; t + duration * 60_000 <= end.toMillis(); t += QUANTUM) {
  const finish = t + duration * 60_000;
  const allowed = buckets(new Date(t), new Date(finish)).every(bucket => {
   const local = DateTime.fromJSDate(bucket, { zone });
   const minute = local.hour * 60 + local.minute;
   return local.toISODate() === date && rules.some(r => r.weekday === local.weekday && minute >= r.startMinute && minute + 15 <= r.endMinute);
  });
  if (allowed) { const local = DateTime.fromMillis(t, { zone }); slots.push({ start: new Date(t).toISOString(), end: new Date(finish).toISOString(), label: local.toFormat('h:mm a'), offset: local.toFormat('ZZ') }); }
 }
 return { slots, dayHours: hours, notice: hours === 24 ? null : `This date has ${hours} hours in ${zone} because the clocks change. Missing times are omitted; repeated times show their UTC offset. Durations are elapsed time.` };
}
export async function availability(resourceId: string, date: string, duration: number, now = new Date(), session?: ClientSession) {
 const resource = await Resource.findById(resourceId).session(session || null);
 assert(resource, 404, 'Resource not found');
 assert(resource.durations.includes(duration), 400, 'Unsupported booking duration');
 const { start, end } = dayBounds(date, resource.timeZone);
 assert(start.toMillis() < now.getTime() + 366 * 86400_000 && end.toMillis() > now.getTime(), 400, 'Choose a date within the next year');
 const rules = await AvailabilityRule.find({ resourceId }).session(session || null).lean();
 const calculated = candidateSlots(date, resource.timeZone, duration, rules);
 const blackout = await AvailabilityException.findOne({ resourceId, date }).session(session || null);
 if (blackout) return { ...calculated, slots: [], notice: `Closed: ${blackout.reason || 'Venue blackout date'}`, resource, amount: Math.round(resource.hourlyRate * duration / 60) };
 const occupied = await Occupancy.find({ resourceId, bucket: { $gte: start.toJSDate(), $lt: end.toJSDate() } }).session(session || null).lean();
 const active = await ReservationHold.find({ _id: { $in: occupied.map(o => o.holdId) }, $or: [{ state: 'consumed' }, { state: 'active', expiresAt: { $gt: now } }] }).session(session || null).lean();
 const activeIds = new Set(active.map(h => String(h._id)));
 const taken = new Set(occupied.filter(o => activeIds.has(String(o.holdId))).map(o => +o.bucket));
 return { ...calculated, resource, amount: Math.round(resource.hourlyRate * duration / 60), slots: calculated.slots.filter(s => +new Date(s.start) > +now && !buckets(new Date(s.start), new Date(s.end)).some(b => taken.has(+b))) };
}

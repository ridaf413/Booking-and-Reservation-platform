import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { connect } from './db.js';
import { AvailabilityRule, Resource, User, Venue } from './models.js';
export async function seed() {
 const passwordHash = await bcrypt.hash('RoomlyDemo123!', 12);
 const admin = await User.findOneAndUpdate({ email: 'admin@roomly.test' }, { $setOnInsert: { name: 'Alex Morgan', role: 'venue-admin', passwordHash } }, { upsert: true, new: true });
 await User.findOneAndUpdate({ email: 'customer@roomly.test' }, { $setOnInsert: { name: 'Jamie Chen', role: 'customer', passwordHash } }, { upsert: true, new: true });
 const venues = [];
 for (const data of [{ name: 'The Collective', city: 'New York', address: '120 Spring Street, SoHo' }, { name: 'North House', city: 'London', address: '42 Clerkenwell Road' }]) venues.push(await Venue.findOneAndUpdate({ name: data.name, adminId: admin._id }, { $setOnInsert: data }, { upsert: true, new: true }));
 const rooms = [
  { name: 'The Boardroom', description: 'Big ideas deserve a little more room. A light-filled space for team sessions and your next great presentation.', kind: 'Meeting room', capacity: 12, hourlyRate: 6500, amenities: ['Display', 'Whiteboard', 'Video conferencing', 'Coffee'], color: 'sand', venueId: venues[0]._id, timeZone: 'America/New_York' },
  { name: 'The Focus Room', description: 'A quiet corner to connect, collaborate, and get things moving. Perfect for small teams.', kind: 'Meeting room', capacity: 4, hourlyRate: 3000, amenities: ['Display', 'Whiteboard', 'Coffee'], color: 'green', venueId: venues[0]._id, timeZone: 'America/New_York' },
  { name: 'The Open Studio', description: 'Spread out and make something new. Flexible seating and natural light for your most creative days.', kind: 'Studio', capacity: 8, hourlyRate: 4500, amenities: ['Whiteboard', 'Flexible seating', 'Coffee'], color: 'rose', venueId: venues[0]._id, timeZone: 'America/New_York' },
  { name: 'The Common Table', description: 'Your team’s home for the day. A welcoming workspace with everything you need to settle in.', kind: 'Coworking', capacity: 6, hourlyRate: 2500, amenities: ['Fast Wi-Fi', 'Power outlets', 'Coffee'], color: 'blue', venueId: venues[1]._id, timeZone: 'Europe/London' }
 ];
 for (const room of rooms) {
  const resource = await Resource.findOneAndUpdate({ name: room.name, venueId: room.venueId }, { $setOnInsert: { ...room, cancellationHours: 24, durations: [30, 60, 90, 120] } }, { upsert: true, new: true });
  if (!await AvailabilityRule.exists({ resourceId: resource._id })) await AvailabilityRule.insertMany(Array.from({ length: 7 }, (_, i) => ({ resourceId: resource._id, weekday: i + 1, startMinute: 8 * 60, endMinute: 20 * 60 })));
 }
}
if (process.argv[1]?.endsWith('seed.ts') || process.argv[1]?.endsWith('seed.js')) { await connect(); await seed(); await mongoose.disconnect(); console.log('Seeded demo accounts: customer@roomly.test / admin@roomly.test — password: RoomlyDemo123!'); }

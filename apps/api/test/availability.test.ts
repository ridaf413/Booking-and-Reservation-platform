import { describe, expect, it } from 'vitest';
import { candidateSlots, dayBounds } from '../src/availability.js';
const allDay = Array.from({ length: 7 }, (_, i) => ({ weekday: i + 1, startMinute: 0, endMinute: 1440 }));
describe('UTC enumeration across daylight-saving transitions', () => {
 it('omits the nonexistent spring-forward hour and explains the 23-hour day', () => {
  const result = candidateSlots('2027-03-14', 'America/New_York', 60, allDay);
  expect(result.dayHours).toBe(23); expect(result.notice).toContain('23 hours');
  expect(result.slots.filter(s => s.label.startsWith('2:') && s.label.endsWith('AM'))).toHaveLength(0);
  expect(result.slots).toHaveLength(89);
 });
 it('offers both repeated fall-back times with distinct offsets and UTC instants', () => {
  const result = candidateSlots('2027-11-07', 'America/New_York', 30, allDay);
  const repeated = result.slots.filter(s => s.label === '1:30 AM');
  expect(result.dayHours).toBe(25); expect(repeated).toHaveLength(2);
  expect(repeated.map(s => s.offset)).toEqual(['-04:00', '-05:00']);
  expect(+new Date(repeated[1].start) - +new Date(repeated[0].start)).toBe(3600000);
 });
 it('handles a half-hour DST transition', () => {
  expect(dayBounds('2027-10-03', 'Australia/Lord_Howe').hours).toBe(23.5);
 });
 it('does not bridge a closed interval or cross the selected date', () => {
  const result = candidateSlots('2027-03-15', 'America/New_York', 60, [{ weekday: 1, startMinute: 540, endMinute: 570 }, { weekday: 1, startMinute: 585, endMinute: 615 }]);
  expect(result.slots).toHaveLength(0);
 });
 it('rejects nonexistent local dates and invalid zones', () => {
  expect(() => dayBounds('2011-12-30', 'Pacific/Apia')).toThrow('does not exist');
  expect(() => dayBounds('2027-02-30', 'America/New_York')).toThrow();
  expect(() => dayBounds('2027-02-20', 'imaginary/zone')).toThrow();
 });
});

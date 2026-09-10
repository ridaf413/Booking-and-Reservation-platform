import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CalendarStrip, Countdown, time } from '../src/components';
afterEach(() => vi.useRealTimers());
describe('accessible date and time selection', () => {
 it('selects a date with the keyboard and announces selected state', async () => {
  const change = vi.fn(); const user = userEvent.setup();
  render(<CalendarStrip value="2027-03-14" onChange={change}/>);
  const day = screen.getByRole('button', { name: 'Sunday, March 14, 2027' }); expect(day).toHaveAttribute('aria-pressed', 'true');
  day.focus(); await user.keyboard('{Tab}{Enter}'); expect(change).toHaveBeenCalledWith('2027-03-15');
 });
 it('navigates weeks without changing the selected date', async () => {
  const change = vi.fn(); render(<CalendarStrip value="2027-03-14" onChange={change}/>);
  await userEvent.click(screen.getByRole('button', { name: 'Next week' })); expect(screen.getByRole('button', { name: 'Sunday, March 21, 2027' })).toBeVisible(); expect(change).not.toHaveBeenCalled();
 });
 it('corrects a skewed browser clock and stops the hold timer at zero', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2027-01-01T15:00:00Z'));
  const onExpire = vi.fn(); render(<Countdown serverNow="2027-01-01T14:00:00Z" expiresAt="2027-01-01T14:00:05Z" onExpire={onExpire}/>);
  expect(screen.getByRole('timer')).toHaveTextContent('0:05'); act(() => vi.advanceTimersByTime(7000)); expect(screen.getByRole('timer')).toHaveTextContent('0:00'); expect(onExpire).toHaveBeenCalled();
 });
 it('disambiguates repeated wall times with UTC offsets', () => {
  expect(time('2027-11-07T05:30:00Z', 'America/New_York')).toContain('GMT-4');
  expect(time('2027-11-07T06:30:00Z', 'America/New_York')).toContain('GMT-5');
 });
});

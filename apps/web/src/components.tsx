import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Clock3, AlertCircle } from 'lucide-react';
export const money = (amount: number, currency = 'usd') => new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: amount % 100 ? 2 : 0 }).format(amount / 100);
export function time(iso: string, zone: string) { return new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit', timeZoneName: 'shortOffset' }).format(new Date(iso)); }
export function fullDate(iso: string, zone: string) { return new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(iso)); }
export function localDate(date = new Date()) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
export function shiftDate(date: string, days: number) { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
export function ErrorNotice({ message }: { message: string }) { return <div className="notice error" role="alert"><AlertCircle size={18}/>{message}</div>; }
export function CalendarStrip({ value, onChange }: { value: string; onChange: (date: string) => void }) {
 const [anchor, setAnchor] = useState(value);
 useEffect(() => { setAnchor(value); }, [value]);
 return <div className="calendar-strip"><button className="icon-button" aria-label="Previous week" onClick={() => setAnchor(shiftDate(anchor, -7))}><ChevronLeft size={18}/></button><div className="calendar-days">{Array.from({ length: 7 }, (_, i) => shiftDate(anchor, i)).map(date => <button key={date} aria-pressed={date === value} aria-label={new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', dateStyle: 'full' })} className={date === value ? 'day selected' : 'day'} onClick={() => onChange(date)}><span>{new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })}</span><strong>{Number(date.slice(-2))}</strong></button>)}</div><button className="icon-button" aria-label="Next week" onClick={() => setAnchor(shiftDate(anchor, 7))}><ChevronRight size={18}/></button></div>;
}
export function Countdown({ expiresAt, serverNow, onExpire }: { expiresAt: string; serverNow: string; onExpire?: () => void }) {
 const [remaining, setRemaining] = useState(0);
 useEffect(() => {
  const offset = Date.parse(serverNow) - Date.now();
  const tick = () => { const seconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - Date.now() - offset) / 1000)); setRemaining(seconds); if (!seconds) onExpire?.(); };
  tick(); const timer = setInterval(tick, 1000); return () => clearInterval(timer);
 }, [expiresAt, serverNow, onExpire]);
 return <div className={`countdown ${remaining < 60 ? 'urgent' : ''}`}><Clock3 size={19}/><span>Your space is held for</span><strong role="timer" aria-label="Hold time remaining">{Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}</strong></div>;
}

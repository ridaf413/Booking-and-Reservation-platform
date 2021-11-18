import { configureStore } from '@reduxjs/toolkit';
import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
export type User = { id: string; name: string; email: string; role: 'customer' | 'venue-admin' };
export type Venue = { _id: string; name: string; city: string; address: string };
export type Resource = { _id: string; venueId: Venue; name: string; description: string; kind: string; capacity: number; hourlyRate: number; currency: string; timeZone: string; cancellationHours: number; durations: number[]; amenities: string[]; color: string };
export type Slot = { start: string; end: string; label: string; offset: string };
export type Hold = { _id: string; resourceId: Resource; start: string; end: string; timeZone: string; amount: number; currency: string; expiresAt: string; state: string; cancellationHours: number };
export type Booking = Omit<Hold, 'state' | 'expiresAt'> & { holdId: string; status: string; paymentStatus: string; userId?: User };
export type Payment = { _id: string; provider: string; checkoutUrl?: string; status: string };
export type Audit = { _id: string; action: string; detail: string; createdAt: string };
export type Rule = { resourceId?: string; weekday: number; startMinute: number; endMinute: number };
export type Exception = { resourceId?: string; date: string; reason: string };
export type ResourceInput = Omit<Resource, '_id' | 'venueId' | 'currency' | 'color'> & { venueId: string; rules: Rule[]; exceptions: Exception[] };
export const api = createApi({
 reducerPath: 'api', baseQuery: fetchBaseQuery({ baseUrl: '/api', credentials: 'include', prepareHeaders: headers => { headers.set('x-roomly-client', 'web'); return headers; } }), tagTypes: ['Auth', 'Bookings', 'Resources', 'Hold'],
 endpoints: b => ({
  me: b.query<User, void>({ query: () => '/auth/me', providesTags: ['Auth'] }),
  login: b.mutation<User, { email: string; password: string }>({ query: body => ({ url: '/auth/login', method: 'POST', body }), invalidatesTags: ['Auth', 'Bookings'] }),
  register: b.mutation<User, { name: string; email: string; password: string }>({ query: body => ({ url: '/auth/register', method: 'POST', body }), invalidatesTags: ['Auth'] }),
  logout: b.mutation<void, void>({ query: () => ({ url: '/auth/logout', method: 'POST' }), invalidatesTags: ['Auth', 'Bookings'] }),
  venues: b.query<Venue[], void>({ query: () => '/venues', providesTags: ['Resources'] }),
  resources: b.query<Resource[], { venue?: string; capacity?: string }>({ query: params => ({ url: '/resources', params }), providesTags: ['Resources'] }),
  availability: b.query<{ resource: Resource; slots: Slot[]; amount: number; notice: string | null; dayHours: number }, { id: string; date: string; duration: number }>({ query: ({ id, ...params }) => ({ url: `/resources/${id}/availability`, params }), providesTags: ['Hold', 'Bookings', 'Resources'] }),
  hold: b.mutation<Hold, { resourceId: string; start: string; duration: number }>({ query: body => ({ url: '/holds', method: 'POST', body }), invalidatesTags: ['Hold'] }),
  getHold: b.query<{ hold: Hold; reservation: Booking | null; payment: Payment | null; serverNow: string }, string>({ query: id => `/holds/${id}`, providesTags: ['Hold'] }),
  payment: b.mutation<Payment, string>({ query: id => ({ url: `/holds/${id}/payment`, method: 'POST' }), invalidatesTags: ['Hold'] }),
  completeMock: b.mutation<{ status: string }, string>({ query: id => ({ url: `/payments/${id}/mock-complete`, method: 'POST' }), invalidatesTags: ['Hold', 'Bookings'] }),
  bookings: b.query<Booking[], void>({ query: () => '/bookings', providesTags: ['Bookings'] }),
  booking: b.query<{ booking: Booking; timeline: Audit[]; refund: { status: string } | null }, string>({ query: id => `/bookings/${id}`, providesTags: ['Bookings'] }),
  cancel: b.mutation<Booking, string>({ query: id => ({ url: `/bookings/${id}/cancel`, method: 'POST' }), invalidatesTags: ['Bookings', 'Hold'] }),
  adminResources: b.query<{ venues: Venue[]; resources: Resource[]; rules: Rule[]; exceptions: Exception[] }, void>({ query: () => '/admin/resources', providesTags: ['Resources'] }),
  saveResource: b.mutation<Resource, { id?: string; body: ResourceInput }>({ query: ({ id, body }) => ({ url: `/admin/resources${id ? `/${id}` : ''}`, method: id ? 'PUT' : 'POST', body }), invalidatesTags: ['Resources'] }),
  createVenue: b.mutation<Venue, { name: string; city: string; address: string }>({ query: body => ({ url: '/admin/venues', method: 'POST', body }), invalidatesTags: ['Resources'] }),
  schedule: b.query<{ bookings: Booking[]; holds: Hold[]; timeline: Audit[] }, { from: string; to: string; resourceId?: string; status?: string }>({ query: params => ({ url: '/admin/schedule', params }), providesTags: ['Bookings', 'Hold', 'Resources'] })
 })
});
export const store = configureStore({ reducer: { [api.reducerPath]: api.reducer }, middleware: getDefault => getDefault().concat(api.middleware) });
export function errorMessage(error: unknown) { return (error as { data?: { error?: string } })?.data?.error || 'Something went wrong. Please try again.'; }

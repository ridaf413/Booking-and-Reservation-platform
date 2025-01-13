import { test, expect } from '@playwright/test';
test('customer books, pays, receives email, views audit history and cancels', async ({ page, request }) => {
 const email = `e2e-${Date.now()}@roomly.test`;
 await request.post('/api/auth/register', { headers: { 'x-roomly-client': 'web' }, data: { name: 'Test Visitor', email, password: 'RoomlyDemo123!' } });
 await page.goto('/login'); await page.getByLabel('Email address').fill(email); await page.getByLabel('Password', { exact: true }).fill('RoomlyDemo123!'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
 await expect(page.getByRole('heading', { name: 'A space for your next idea.' })).toBeVisible();
 const future = new Date(); future.setDate(future.getDate() + 4); const date = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, '0')}-${String(future.getDate()).padStart(2, '0')}`;
 await page.getByLabel('Booking date').fill(date);
 await page.locator('.slots .slot').first().click(); await page.getByRole('button', { name: 'Reserve this space' }).click();
 await expect(page.getByRole('timer')).toBeVisible(); await page.getByRole('button', { name: /Continue to payment/ }).click();
 await expect(page.getByRole('heading', { name: 'You’re all booked.' })).toBeVisible({ timeout: 30000 });
 await expect(page.getByText('reservation · confirmed', { exact: true })).toBeVisible();
 const bookingUrl = page.url(); await page.reload(); await expect(page.getByText('Payment · paid', { exact: true })).toBeVisible();
 await expect.poll(async () => { const response = await request.get(`http://localhost:8025/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`); const messages = await response.json(); return messages.messages?.some((m: { Subject: string }) => m.Subject === 'Your Roomly booking is confirmed'); }, { timeout: 20000 }).toBe(true);
 await page.getByRole('button', { name: 'Cancel booking', exact: true }).click(); await page.getByRole('button', { name: 'Yes, cancel booking' }).click();
 await expect(page.getByRole('heading', { name: 'Booking cancelled.' })).toBeVisible(); await expect(page.getByText('Payment · refunded', { exact: true })).toBeVisible({ timeout: 20000 });
 await page.goto('/bookings'); await expect(page.locator('.booking-row').filter({ hasText: 'cancelled' })).toBeVisible();
 await page.goto(bookingUrl); await expect(page.getByText('refund · succeeded', { exact: true })).toBeVisible();
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
test('venue admin can filter the schedule and configure a space', async ({ page }) => {
 await page.goto('/login'); await page.getByLabel('Email address').fill('admin@roomly.test'); await page.getByLabel('Password', { exact: true }).fill('RoomlyDemo123!'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
 await page.getByRole('link', { name: 'Venue management' }).click(); await expect(page.getByRole('heading', { name: 'Room to run things.' })).toBeVisible();
 await page.getByLabel('Booking status').selectOption('confirmed'); await page.getByRole('tab', { name: 'Spaces & settings' }).click();
 await page.getByRole('button', { name: 'Configure' }).first().click(); await expect(page.getByLabel('IANA time zone')).toHaveValue('America/New_York');
 await page.getByRole('button', { name: 'Save space', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Your spaces' })).toBeVisible();
 await page.getByRole('button', { name: 'Sign out' }).click(); await expect(page.getByRole('heading', { name: 'Good to have you here.' })).toBeVisible();
 await page.goto('/admin'); await expect(page).toHaveURL(/login/);
});

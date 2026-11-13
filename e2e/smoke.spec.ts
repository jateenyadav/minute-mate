import { test, expect } from '@playwright/test';

/** A 4-second 16 kHz WAV tone: a stand-in recording (the local fake AI returns a canned transcript). */
function toneWav(seconds = 4, rate = 16000) {
  const n = seconds * rate;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), 44 + i * 2);
  return buf;
}

test('demo meeting → actions → ask → transcript → new recording → minutes, no console errors', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Drop in a meeting/ })).toBeVisible();
  await page.screenshot({ path: `test-results/landing-${info.project.name}.png`, fullPage: true });
  await page.getByRole('button', { name: 'Try the demo' }).click();

  await page.getByRole('button', { name: /Pocket Wallet weekly sync/ }).click();
  await expect(page.getByTestId('actions')).toContainText('Get the final cashback budget');
  await page.getByLabel('Done: Share two Diwali banner options').check();
  await page.screenshot({ path: `test-results/minutes-${info.project.name}.png`, fullPage: true });

  await page.getByRole('button', { name: 'Ask this meeting' }).click();
  await page.getByRole('button', { name: 'What was decided?' }).click();
  await expect(page.getByTestId('answers')).toContainText('Priya will update the docs');

  await page.getByRole('button', { name: 'Transcript', exact: true }).click();
  await page.getByLabel('Search the transcript').fill('finance');
  await expect(page.getByTestId('transcript').locator('li')).toHaveCount(2);

  await page.getByRole('button', { name: '← All meetings' }).click();
  await expect(page.getByTestId('meetings')).toContainText('3 open of 5 actions');
  await page.getByRole('button', { name: '＋ New meeting' }).click();
  await page.getByTestId('audio-input').setInputFiles({ name: 'standup.wav', mimeType: 'audio/wav', buffer: toneWav() });
  await page.getByRole('button', { name: 'Make the minutes' }).click();

  await expect(page.getByRole('heading', { name: 'Release planning' })).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('actions')).toContainText('Update the docs');
  await expect(page.locator('audio')).toBeVisible(); // the picked recording can be played from timestamps
  await expect(page.getByRole('link', { name: '⬇ Markdown' })).toHaveAttribute('href', /export\.md/);
  await page.screenshot({ path: `test-results/new-${info.project.name}.png`, fullPage: true });

  expect(errors).toEqual([]);
});

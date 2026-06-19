import { expect, test } from 'vitest';
import { withDeadline } from '../src/timeout.js';

test('resolves when the promise settles before the deadline', async () => {
  await expect(withDeadline(Promise.resolve('ok'), 1000, 'x')).resolves.toBe('ok');
});

test('rejects with deadline error when the promise is too slow', async () => {
  const slow = new Promise((r) => setTimeout(() => r('late'), 50));
  await expect(withDeadline(slow, 5, 'convert page')).rejects.toThrow(/deadline exceeded after 5ms: convert page/);
});

test('propagates the original rejection when the promise fails fast', async () => {
  await expect(withDeadline(Promise.reject(new Error('boom')), 1000, 'x')).rejects.toThrow('boom');
});

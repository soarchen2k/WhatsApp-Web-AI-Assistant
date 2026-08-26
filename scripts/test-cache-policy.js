const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  const policy = await import(pathToFileURL(path.resolve(__dirname, '../src/cache-policy.mjs')));

  const entries = Array.from({ length: 20 }, (_, index) => [
    `message:${index}`,
    { text: `message ${index} ${'x'.repeat(80)}` }
  ]);
  const envelope = policy.createBoundedMessageEnvelope(entries, 3, 900, 1234);
  assert(envelope.truncated, 'oversized message cache was not marked as truncated');
  assert(envelope.entries.length < entries.length, 'oldest messages were not removed');
  assert.strictEqual(envelope.entries.at(-1)[0], 'message:19', 'newest message was not retained');
  assert(policy.getSerializedByteLength(envelope) <= 900, 'bounded message envelope still exceeds its limit');

  const eviction = policy.chooseOldestEvictions([
    { key: 'new', updatedAt: 30, bytes: 40 },
    { key: 'old', updatedAt: 10, bytes: 40 },
    { key: 'middle', updatedAt: 20, bytes: 40 }
  ], 180, 100);
  assert.deepStrictEqual(eviction.removeKeys, ['old', 'middle']);
  assert.strictEqual(eviction.projectedBytes, 100);

  const mediaPlan = policy.planMediaEvictions([
    { key: 'old-video', updatedAt: 1, size: 60 },
    { key: 'current-video', updatedAt: 2, size: 50 }
  ], { key: 'current-video', size: 90 }, 100);
  assert.deepStrictEqual(mediaPlan.removeKeys, ['old-video']);
  assert.strictEqual(mediaPlan.projectedBytes, 90);

  console.log('cache policy tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

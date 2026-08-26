export const MESSAGE_CACHE_MAX_BYTES_PER_CHAT = 2 * 1024 * 1024;
export const MESSAGE_CACHE_TOTAL_BUDGET_BYTES = 8 * 1024 * 1024;
export const MEDIA_CACHE_MAX_ASSET_BYTES = 128 * 1024 * 1024;
export const MEDIA_CACHE_TOTAL_BUDGET_BYTES = 256 * 1024 * 1024;

export function getSerializedByteLength(value) {
  if (value === undefined) return 0;
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function createBoundedMessageEnvelope(entries, version, maxBytes, updatedAt = Date.now()) {
  let boundedEntries = [...entries];
  let envelope = { version, updatedAt, truncated: false, entries: boundedEntries };

  while (boundedEntries.length > 1 && getSerializedByteLength(envelope) > maxBytes) {
    const removeCount = Math.max(1, Math.ceil(boundedEntries.length * 0.1));
    boundedEntries = boundedEntries.slice(removeCount);
    envelope = { ...envelope, truncated: true, entries: boundedEntries };
  }

  return envelope;
}

export function chooseOldestEvictions(candidates, projectedBytes, budgetBytes) {
  const removeKeys = [];
  const oldestFirst = [...candidates].sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));

  for (const candidate of oldestFirst) {
    if (projectedBytes <= budgetBytes) break;
    projectedBytes -= candidate.bytes || candidate.size || 0;
    removeKeys.push(candidate.key);
  }

  return { removeKeys, projectedBytes };
}

export function planMediaEvictions(existingRecords, record, budgetBytes) {
  const replacedRecord = existingRecords.find(item => item.key === record.key);
  const currentBytes = existingRecords.reduce((total, item) => total + (item.size || 0), 0);
  const initialBytes = currentBytes - (replacedRecord?.size || 0) + record.size;
  const candidates = existingRecords.filter(item => item.key !== record.key);
  return chooseOldestEvictions(candidates, initialBytes, budgetBytes);
}

export function parseRecordId(value: string | number): number {
  if (typeof value === 'string' && !/^\d+$/.test(value)) throw new Error('Expected a numeric record ID');
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 0) throw new Error('Expected a nonnegative safe integer record ID');
  return id;
}

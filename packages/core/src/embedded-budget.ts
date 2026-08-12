import { ScenarioError } from './schema.js';

const MAX_EMBEDDED_BYTES = 64 * 1024 * 1024;

export function addEmbeddedBytes(totalBytes: number, nextBytes: number, pointer: string): number {
  const total = totalBytes + nextBytes;
  if (total > MAX_EMBEDDED_BYTES) throw new ScenarioError('SOURCE_SIZE', 'Embedded sources exceed 64 MiB', pointer);
  return total;
}

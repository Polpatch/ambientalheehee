import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const sourceDir = resolve(root, 'assets/source');
const scenarioPath = resolve(root, 'packages/core/assets/default-scenario.json');
const sampleRate = 44_100;

function pcm16Wav(samples) {
  const dataSize = samples.length * 2;
  const bytes = Buffer.alloc(44 + dataSize);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(36 + dataSize, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i += 1) bytes.writeInt16LE(Math.max(-1, Math.min(1, samples[i])) * 32767, 44 + i * 2);
  return bytes;
}

function noise() {
  let state = 0x6d2b79f5;
  return Array.from({ length: sampleRate * 5 }, () => {
    state |= 0; state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ state >>> 15, 1 | state); t = (t + Math.imul(t ^ t >>> 7, 61 | t)) ^ t;
    return (((t ^ t >>> 14) >>> 0) / 0x1_0000_0000) * 0.4 - 0.2;
  });
}
function chime() { return Array.from({ length: Math.round(sampleRate * 1.5) }, (_, i) => 0.2 * Math.sin(2 * Math.PI * 523.25 * i / sampleRate) * Math.exp(-3 * i / sampleRate)); }

const files = { 'default-white-noise.wav': pcm16Wav(noise()), 'default-chime.wav': pcm16Wav(chime()) };
const scenario = {
  version: 1, name: 'Night clearing',
  bases: [{ id: 'white-noise', source: { location: `data:audio/wav;base64,${files['default-white-noise.wav'].toString('base64')}`, volume: { min: 0.25, max: 0.25 } } }],
  jumpers: [{ id: 'chime', sources: [{ location: `data:audio/wav;base64,${files['default-chime.wav'].toString('base64')}`, volume: { min: 0.25, max: 0.4 } }], schedule: { algorithm: 'increasing_gaussian', mean_interval_seconds: 15, stddev_seconds: 4 } }]
};
const outputs = [...Object.entries(files).map(([name, contents]) => [resolve(sourceDir, name), contents]), [scenarioPath, Buffer.from(`${JSON.stringify(scenario, null, 2)}\n`)]];
if (process.argv.includes('--check')) {
  for (const [path, expected] of outputs) {
    let actual; try { actual = await readFile(path); } catch { throw new Error(`Missing generated file: ${path}`); }
    if (!actual.equals(expected)) throw new Error(`Generated artifact drift: ${path} (${createHash('sha256').update(actual).digest('hex')})`);
  }
} else for (const [path, contents] of outputs) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, contents); }

import { describe, expect, it } from 'vitest';
import { inspectDataUri, inspectImageDataUri, parseScenario, ScenarioError } from './schema.js';
import { addEmbeddedBytes } from './embedded-budget.js';
import { IncreasingGaussianSchedule } from './scheduler.js';

const wav = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

describe('scenario contract', () => {
  it('accepts the inline-only web scenario', () => expect(parseScenario(JSON.stringify({ version: 1, name: 'x', bases: [{ id: 'base', source: { location: wav } }], jumpers: [] }), 'web').bases).toHaveLength(1));
  it('rejects local web locations', () => expect(() => parseScenario(JSON.stringify({ version: 1, name: 'x', bases: [{ id: 'base', source: { location: 'a.wav' } }], jumpers: [] }), 'web')).toThrow('Source not allowed'));
  it('rejects noncanonical data URI', () => expect(() => inspectDataUri('data:audio/wav;base64,AA')).toThrow('canonical'));
  it('accepts a validated embedded Jumper image', () => {
    const scenario = parseScenario(JSON.stringify({ version: 1, name: 'x', bases: [], jumpers: [{ id: 'birds', image: png, sources: [{ location: wav }], schedule: { algorithm: 'increasing_gaussian', mean_interval_seconds: 1, stddev_seconds: 0 } }] }), 'web');
    expect(scenario.jumpers[0]?.image).toBe(png);
    expect(inspectImageDataUri(png).mime).toBe('image/png');
  });
  it('rejects an image whose MIME disagrees with its signature', () => {
    const mismatched = png.replace('data:image/png', 'data:image/jpeg');
    expect(() => inspectImageDataUri(mismatched)).toThrow('MIME');
  });
});

describe('increasing gaussian schedule', () => {
  it('returns mean for zero deviation', () => expect(new IncreasingGaussianSchedule(15, 0).nextDelay({ next: () => 0.5 })).toBe(15000));
});

describe('embedded source budget', () => {
  it('attributes an aggregate overflow to the current source', () => {
    try { addEmbeddedBytes(64 * 1024 * 1024, 1, 'jumpers/0/sources/1'); }
    catch (error) {
      expect(error).toBeInstanceOf(ScenarioError);
      if (error instanceof ScenarioError) {
        expect(error.code).toBe('SOURCE_SIZE');
        expect(error.pointer).toBe('jumpers/0/sources/1');
      }
    }
  });
  it('attributes malformed data URIs to their source', () => {
    try { parseScenario(JSON.stringify({ version: 1, name: 'x', bases: [{ id: 'base', source: { location: 'data:audio/wav;base64,AA' } }] }), 'web'); }
    catch (error) {
      expect(error).toBeInstanceOf(ScenarioError);
      if (error instanceof ScenarioError) expect(error.pointer).toBe('bases/0/source');
    }
  });
});

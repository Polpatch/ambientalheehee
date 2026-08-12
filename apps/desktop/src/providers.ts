import { createHash, randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
export interface DesktopSource { location: string; clip?: { start_seconds: number; end_seconds: number } | undefined; }
export interface ProviderResult { token: string; path: string; mime: 'audio/wav' | 'audio/mpeg'; durationSeconds: number; }
export interface ExtractedAudio { bytes: Uint8Array; durationSeconds: number; name: string; }
const mimeFor = (path: string): ProviderResult['mime'] => path.toLowerCase().endsWith('.wav') ? 'audio/wav' : path.toLowerCase().endsWith('.mp3') ? 'audio/mpeg' : (() => { throw new Error('Only WAV and MP3 are supported'); })();
async function tool(name: 'ffprobe' | 'yt-dlp' | 'ffmpeg') { const candidates = [process.env[`AMBIENTALHEEHEE_${name.replace('-', '').toUpperCase()}`], name, `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`].filter(Boolean) as string[]; for (const candidate of candidates) try { await access(candidate); return candidate; } catch {} throw Object.assign(new Error(`Required tool missing: ${name}`), { code: 'TOOL_MISSING' }); }
async function run(file: string, args: string[], signal?: AbortSignal) { return await new Promise<string>((resolveRun, reject) => { const child = spawn(file, args, { shell: false, detached: true }); let stdout = ''; let stderr = ''; child.stdout.on('data', (value) => { stdout += value; }); child.stderr.on('data', (value) => { stderr += value; }); const abort = () => { if (child.pid) process.kill(-child.pid, 'SIGTERM'); }; signal?.addEventListener('abort', abort, { once: true }); child.once('error', reject); child.once('close', (code) => { signal?.removeEventListener('abort', abort); code === 0 ? resolveRun(stdout) : reject(new Error(stderr.slice(0, 8192))); }); }); }
async function probe(path: string, signal?: AbortSignal) { const ffprobe = await tool('ffprobe'); const output = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', path], signal); const duration = JSON.parse(output).format.duration; if (!Number.isFinite(Number(duration)) || Number(duration) <= 0) throw new Error('Invalid media metadata'); return Number(duration); }
export class DesktopProviderRegistry {
  private readonly grants = new Map<string, ProviderResult>();
  private readonly directories = new Set<string>();
  private readonly grantDirectories = new Map<string, string>();

  async resolve(source: DesktopSource, scenarioDirectory: string, signal?: AbortSignal): Promise<ProviderResult> {
    if (/^https:\/\//.test(source.location)) return this.youtube(source.location, signal);
    const root = resolve(scenarioDirectory);
    const absolute = source.location.startsWith('/');
    const path = await realpath(absolute ? source.location : resolve(root, source.location));
    if (!absolute && !path.startsWith(`${root}/`) && path !== root) throw new Error('Local source escapes audio root');
    const info = await stat(path);
    if (!info.isFile()) throw new Error('Local source is not a regular file');
    const result = { token: randomUUID(), path, mime: mimeFor(path), durationSeconds: await probe(path, signal) };
    this.grants.set(result.token, result);
    return result;
  }

  get(token: string) { return this.grants.get(token); }

  async revoke(token: string) {
    this.grants.delete(token);
    const directory = this.grantDirectories.get(token);
    if (!directory) return;
    this.grantDirectories.delete(token);
    this.directories.delete(directory);
    await rm(directory, { recursive: true, force: true });
  }

  async extractWav(source: DesktopSource, scenarioDirectory: string, signal?: AbortSignal): Promise<ExtractedAudio> {
    let resolved: ProviderResult;
    if (source.location.startsWith('data:')) {
      const match = /^data:(audio\/(?:wav|mpeg));base64,([A-Za-z0-9+/]*={0,2})$/.exec(source.location);
      if (!match) throw new Error('Invalid embedded audio');
      const directory = await mkdtemp(join(tmpdir(), 'ambiental-embedded-'));
      this.directories.add(directory);
      const input = join(directory, match[1] === 'audio/wav' ? 'input.wav' : 'input.mp3');
      await writeFile(input, Buffer.from(match[2]!, 'base64'));
      resolved = { token: randomUUID(), path: input, mime: match[1] as ProviderResult['mime'], durationSeconds: await probe(input, signal) };
    } else {
      resolved = await this.resolve(source, scenarioDirectory, signal);
    }
    const ffmpeg = await tool('ffmpeg');
    const directory = await mkdtemp(join(tmpdir(), 'ambiental-wav-'));
    this.directories.add(directory);
    const path = join(directory, 'clip.wav');
    const args = ['-y'];
    if (source.clip) args.push('-ss', String(source.clip.start_seconds), '-to', String(source.clip.end_seconds));
    args.push('-i', resolved.path, '-vn', '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '2', path);
    await run(ffmpeg, args, signal);
    return { bytes: new Uint8Array(await readFile(path)), durationSeconds: await probe(path, signal), name: `${basename(resolved.path).replace(/\.[^.]+$/, '')}.wav` };
  }

  async saveWav(source: DesktopSource, scenarioDirectory: string, outputPath: string, signal?: AbortSignal) {
    const extracted = await this.extractWav(source, scenarioDirectory, signal);
    await writeFile(outputPath, extracted.bytes);
    return { path: outputPath, durationSeconds: extracted.durationSeconds };
  }

  async revokeAll() {
    this.grants.clear();
    this.grantDirectories.clear();
    await Promise.all([...this.directories].map((directory) => rm(directory, { recursive: true, force: true })));
    this.directories.clear();
  }

  private async youtube(url: string, signal?: AbortSignal): Promise<ProviderResult> {
    if (!/^https:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?v=[^&]+|shorts\/[^?]+|embed\/[^?]+)|youtu\.be\/[^?]+)$/.test(url)) throw new Error('Unsupported YouTube URL');
    const ytdlp = await tool('yt-dlp');
    const ffmpeg = await tool('ffmpeg');
    const directory = await mkdtemp(join(tmpdir(), 'ambiental-'));
    this.directories.add(directory);
    const output = join(directory, 'audio.mp3');
    await run(ytdlp, ['--no-playlist', '-x', '--audio-format', 'mp3', '--ffmpeg-location', ffmpeg, '-o', output, url], signal);
    const path = await realpath(output);
    const result = { token: createHash('sha256').update(path).digest('hex'), path, mime: 'audio/mpeg' as const, durationSeconds: await probe(path, signal) };
    this.grants.set(result.token, result);
    this.grantDirectories.set(result.token, directory);
    return result;
  }
}

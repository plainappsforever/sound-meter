/**
 * @jest-environment node
 */
// A12 "no audio stored" scan (SPEC §3.5, §14, D13): only levels are ever persisted.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..');

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const sources = [...files(join(ROOT, 'src')), ...files(join(ROOT, 'modules'))];
const rel = (p: string) => relative(ROOT, p);

/** Files allowed to write files later: report/CSV/backup sharing (P5/P6). None exist yet. */
const FILE_WRITERS_ALLOWED = ['src/lib/share.ts', 'src/lib/backup-io.ts'];

describe('A12: no audio is stored, sent or logged', () => {
  it('the schema has exactly one BLOB column, the 900-byte level block', () => {
    const sql = readFileSync(join(ROOT, 'src/db/migrations.ts'), 'utf8').replace(/\/\/.*$/gm, ''); // code, not comments
    const blobs = sql.match(/\bBLOB\b/g) ?? [];
    expect(blobs).toHaveLength(1);
    expect(sql).toMatch(/data BLOB NOT NULL CHECK \(length\(data\) = 900\)/);
  });

  it('no file-writing or recording API outside the allowed share/backup files', () => {
    const forbidden = [
      /expo-file-system/,
      /writeAsStringAsync/,
      /new File\(/,
      /\bwriteFile/,
      /from 'node:fs'/,
      /expo-av/,
      /useAudioRecorder|prepareToRecordAsync|AudioModule\.record/,
      /MediaRecorder/,
    ];
    for (const f of sources) {
      if (FILE_WRITERS_ALLOWED.includes(rel(f))) continue;
      const text = readFileSync(f, 'utf8');
      for (const re of forbidden) expect([rel(f), re.test(text)]).toEqual([rel(f), false]);
    }
  });

  it('the database layer never sees PCM (no Float32Array/ArrayBuffer/PcmChunk in src/db)', () => {
    for (const f of sources.filter((p) => rel(p).startsWith('src/db/'))) {
      const text = readFileSync(f, 'utf8');
      expect([rel(f), /Float32Array|Float64Array|ArrayBuffer|PcmChunk/.test(text)]).toEqual([rel(f), false]);
    }
  });

  it('engines, data and capture glue never log (no console.* that could print a buffer)', () => {
    for (const f of sources.filter((p) => /^(src\/(engine|db|lib)|modules)\//.test(rel(p)))) {
      expect([rel(f), /console\.(log|info|warn|error|debug)/.test(readFileSync(f, 'utf8'))]).toEqual([rel(f), false]);
    }
  });

  it('the capture module API has no function that writes, saves or exports audio', () => {
    const api = readFileSync(join(ROOT, 'modules/mic-pcm/src/MicPcm.types.ts'), 'utf8');
    const iface = api.slice(api.indexOf('export interface MicPcm'));
    const methods = [...iface.matchAll(/^\s{2}(\w+)\??[(:<]/gm)].map((m) => m[1]);
    expect(methods).toEqual([
      'getInfo',
      'requestPermission',
      'start',
      'stop',
      'read',
      'updateNotification',
      'addListener',
      'setSyntheticSource',
      'getCaptureState',
      'startLevels',
      'processFixture',
    ]);
    // processFixture takes a PCM fixture IN memory and returns levels; the name says "fixture", not "file"
    for (const m of methods) expect([m, /write|save|file(?!x)|persist|export|upload|record(?!s)/i.test(m)]).toEqual([m, false]);
  });

  // Review S9: P3 adds Swift/Kotlin. The scan covers native sources BEFORE they exist, with the platform APIs that can
  // write audio (or anything) to storage. A native file that needs one of them must be listed here with a reason.
  const NATIVE_WRITERS_ALLOWED: string[] = [];
  const NATIVE_FORBIDDEN = [
    /\bAVAudioFile\b/,
    /\bAVAudioRecorder\b/,
    /\bAVAssetWriter\b/,
    /\bExtAudioFile\w*/,
    /\bAudioFileCreate\w*|\bAudioFileWrite\w*/,
    /\.write\(to:|\bwriteToFile\b|\bFileHandle\b|\bFileManager\b[^\n]*createFile/,
    /\bUserDefaults\b/,
    /\bMediaRecorder\b/,
    /\bMediaMuxer\b/,
    /\bFileOutputStream\b|\bRandomAccessFile\b|\bFileWriter\b|\bBufferedWriter\b/,
    /\bopenFileOutput\b|\bFiles\.write\b|\bwriteBytes\(|\bwriteText\(/,
    /SharedPreferences\b/,
    /\bfopen\s*\(|\bfwrite\s*\(/,
  ];
  function nativeFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (name === 'node_modules' || name === 'build') continue;
      if (statSync(p).isDirectory()) nativeFiles(p, out);
      else if (/\.(swift|kt|kts|java|m|mm|c|cpp|h)$/.test(name)) out.push(p);
    }
    return out;
  }
  const nativeHits = (text: string) => NATIVE_FORBIDDEN.filter((re) => re.test(text)).map(String);

  it('native capture code (modules/**/*.swift|kt|java|m|mm|c|cpp) uses no audio/file writer API (review S9)', () => {
    for (const f of nativeFiles(join(ROOT, 'modules'))) {
      if (NATIVE_WRITERS_ALLOWED.includes(rel(f))) continue;
      expect([rel(f), nativeHits(readFileSync(f, 'utf8'))]).toEqual([rel(f), []]);
    }
  });

  it('the native scan catches the writers it is meant to catch (patterns tested on samples)', () => {
    const bad = [
      'let file = try AVAudioFile(forWriting: url, settings: s)',
      'let rec = AVAudioRecorder(url: u, settings: s)',
      'try data.write(to: url)',
      'ExtAudioFileCreateWithURL(url, kAudioFileWAVEType, &fmt, nil, 0, &ref)',
      'val out = FileOutputStream(file)',
      'val r = MediaRecorder(context)',
      'context.openFileOutput("pcm.raw", MODE_PRIVATE)',
      'File(path).writeBytes(buf)',
      'getSharedPreferences("x", 0)',
      'FILE *f = fopen("a.pcm", "wb");',
    ];
    for (const b of bad) expect([b, nativeHits(b).length > 0]).toEqual([b, true]);
    const ok = ['audioRecord.read(buffer, 0, n, AudioRecord.READ_BLOCKING)', 'engine.inputNode.installTap(onBus: 0, bufferSize: 4800, format: fmt)'];
    for (const g of ok) expect([g, nativeHits(g)]).toEqual([g, []]);
  });
});

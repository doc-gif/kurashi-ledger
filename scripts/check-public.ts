// `npm run check:public`: 公開検査（docs/public-data.md）。
//   引数なし      indexにある追跡中の全ファイルを検査する
//   --staged      commitしようとしている変更（追加・変更・名前変更）だけを検査する
//   --redact-paths 結果にファイル名を出さない（環境変数CI=trueのときも同じ）
// 検出は追加の防御で、保証ではない。公開する差分は自分で読む。
import { execFileSync, spawnSync } from 'node:child_process';
import { inspectPublicFile, pathFindings } from './lib/public-policy.ts';

type IndexEntry = { readonly mode: string; readonly oid: string; readonly path: string };

const args = new Set(process.argv.slice(2));
const unknown = [...args].filter((a) => a !== '--staged' && a !== '--redact-paths');
if (unknown.length > 0) {
  console.error(`知らない引数: ${unknown.join(' ')}（使えるのは --staged と --redact-paths）`);
  process.exit(2);
}
const stagedOnly = args.has('--staged');
const redact = args.has('--redact-paths') || process.env['CI'] === 'true';

function git(gitArgs: readonly string[], input?: Buffer): Buffer {
  return execFileSync('git', gitArgs, {
    input,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
}

function splitNul(buffer: Buffer): string[] {
  return buffer.toString('utf8').split('\0').filter((s) => s !== '');
}

function readIndex(): IndexEntry[] {
  // 形式: "<mode> <oid> <stage>\t<path>"（-zでNUL区切り。パスは引用符で囲まれない）
  return splitNul(git(['ls-files', '--stage', '-z'])).map((line) => {
    const tab = line.indexOf('\t');
    const [mode = '', oid = ''] = line.slice(0, tab).split(' ');
    return { mode, oid, path: line.slice(tab + 1) };
  });
}

// git cat-file --batch で中身をまとめて読む（oidには改行が入らないので行単位で渡せる）。
function readBlobs(oids: readonly string[]): Map<string, Buffer> {
  const blobs = new Map<string, Buffer>();
  if (oids.length === 0) return blobs;
  const out = git(['cat-file', '--batch'], Buffer.from(`${oids.join('\n')}\n`));
  let offset = 0;
  while (offset < out.length) {
    const newline = out.indexOf(0x0a, offset);
    const header = out.subarray(offset, newline).toString('utf8');
    const [oid = '', type = '', size = ''] = header.split(' ');
    if (type === 'missing' || size === '') throw new Error(`gitのオブジェクトを読めない: ${oid}`);
    const start = newline + 1;
    const end = start + Number(size);
    blobs.set(oid, out.subarray(start, end));
    offset = end + 1;
  }
  return blobs;
}

const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
if (inside.status !== 0 || inside.stdout.trim() !== 'true') {
  console.error('Gitの作業ツリーの中で実行する。');
  process.exit(2);
}

let entries = readIndex();
if (stagedOnly) {
  const changed = new Set(splitNul(git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMRT'])));
  entries = entries.filter((e) => changed.has(e.path));
}

// submodule（gitlink、mode 160000）は、このrepoに中身がないので読まないが、置き場所の規則は当てる。
const isGitlink = (e: IndexEntry): boolean => e.mode === '160000';
const findings: { readonly index: number; readonly path: string; readonly reasons: readonly string[] }[] = [];
const blobs = readBlobs([...new Set(entries.filter((e) => !isGitlink(e)).map((e) => e.oid))]);
entries.forEach((entry, i) => {
  let reasons: string[];
  if (isGitlink(entry)) {
    reasons = pathFindings(entry.path);
  } else {
    const content = blobs.get(entry.oid);
    if (content === undefined) throw new Error('gitのオブジェクトを読めない');
    reasons = inspectPublicFile(entry.path, content);
  }
  if (reasons.length > 0) findings.push({ index: i + 1, path: entry.path, reasons: [...new Set(reasons)] });
});

const scope = stagedOnly ? 'commitしようとしている' : '追跡中の';
if (findings.length > 0) {
  for (const f of findings) {
    const where = redact ? `項目${f.index}` : f.path;
    console.error(`公開しない: ${where}: ${f.reasons.join('、')}`);
  }
  console.error(
    `${scope}${entries.length}件のうち${findings.length}件が規則に当たった。中身はここに表示しない。docs/public-data.md の手順で確かめる。`,
  );
  process.exitCode = 1;
} else {
  console.log(
    `${scope}${entries.length}件を検査し、規則に当たるものはなかった。これは追加の防御で、保証ではない。公開する差分は自分で読む。`,
  );
}

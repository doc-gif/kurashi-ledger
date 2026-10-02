// 固定したNode.jsの版で、型除去とnode:sqliteが警告なしで動くこと（ADR-0002・ADR-0005のT02の検証）。
// package.jsonのdevEnginesより古い版で実行すると、node:sqliteの実験的機能の警告で失敗する。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

// NODE_OPTIONS（--no-warnings等）で警告が隠れないよう、既定の状態で起動する。
function runModule(source: string) {
  const env = { ...process.env };
  delete env['NODE_OPTIONS'];
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], { env, encoding: 'utf8' });
}

test('TypeScriptのファイルを型除去で読み込んでも警告が出ない', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kl-runtime-'));
  try {
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
    writeFileSync(join(dir, 'value.ts'), 'type Yen = number;\nexport const value: Yen = 1200;\n');
    const url = pathToFileURL(join(dir, 'value.ts')).href;
    const r = runModule(`const m = await import(${JSON.stringify(url)}); if (m.value !== 1200) process.exit(3);`);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('node:sqliteを読み込んで使っても警告が出ない', () => {
  const r = runModule(
    [
      "const { DatabaseSync } = await import('node:sqlite');",
      "const db = new DatabaseSync(':memory:');",
      "db.exec('CREATE TABLE t (yen INTEGER NOT NULL)');",
      "db.prepare('INSERT INTO t (yen) VALUES (?)').run(0);",
      "const row = db.prepare('SELECT yen FROM t').get();",
      'db.close();',
      'if (row.yen !== 0) process.exit(3);',
    ].join('\n'),
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '', `Node.js ${process.version}`);
});

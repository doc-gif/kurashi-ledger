// tests/support/windows-console.tsの、CreateProcessWに渡すコマンドラインの組み立て（すべてのOSで実行）。
// 期待値は、CommandLineToArgvWの規則（引用符の中の空白は区切らない、引用符の直前の\の並びは2つで1つの\、
// \"は引用符そのもの、引用符の直前でない\はそのまま）から手で書いた。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { windowsCommandLine } from './windows-console.ts';

test('コンソールの補助に渡すコマンドラインは、空白・引用符・末尾の\\・空の引数を、Windowsの規則で引用する', () => {
  assert.equal(windowsCommandLine(['C:\\node\\node.exe', 'scripts\\setup.ts']), 'C:\\node\\node.exe scripts\\setup.ts');
  assert.equal(windowsCommandLine(['C:\\Program Files\\node.exe', 'run', 'setup']), '"C:\\Program Files\\node.exe" run setup');
  assert.equal(windowsCommandLine(['a"b']), '"a\\"b"');
  assert.equal(windowsCommandLine(['a\\\\"b']), '"a\\\\\\\\\\"b"');
  assert.equal(windowsCommandLine(['C:\\dir\\']), 'C:\\dir\\');
  assert.equal(windowsCommandLine(['C:\\a b\\']), '"C:\\a b\\\\"');
  assert.equal(windowsCommandLine(['', 'x']), '"" x');
  assert.equal(windowsCommandLine(['tab\there']), '"tab\there"');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runPageScript } from './page-script.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = name => readFileSync(join(here, '..', name), 'utf8');

// On a phone the compose card must never be wider than the screen. A <select> carrying a
// long nickname reports a large min-content width, and a grid track left at its default
// auto minimum grows to it - which pushed the whole card, including the toggle button,
// past the right edge. These assertions pin the guards that keep every box compressible.
test('compose grid tracks can shrink below their content', () => {
  const css = read('messages.css');
  assert.match(css, /\.form-row \{ display:grid; grid-template-columns:minmax\(0, 1fr\); gap:12px; \}/);
  assert.match(css, /\.message-form-section \{ container-type:inline-size; min-width:0; \}/);
  assert.match(css, /\.community-layout \{ grid-template-columns:minmax\(0, 1fr\); gap:16px; \}/);
});

test('form controls and selects cannot exceed their column', () => {
  const css = read('messages.css');
  const control = css.match(/\.form-control \{[^}]*\}/)[0];
  assert.match(control, /width: 100%/);
  assert.match(control, /max-width: 100%/);
  assert.match(control, /min-width: 0/);
  // Long option text is clipped with an ellipsis instead of painting past the field.
  const select = css.match(/select\.form-control \{[^}]*\}/)[0];
  assert.match(select, /overflow: hidden/);
  assert.match(select, /text-overflow: ellipsis/);
});

test('post text wraps long unbroken runs instead of widening the card', () => {
  for (const file of ['messages.css', 'details.css']) {
    const content = read(file).match(/\.message-content \{[^}]*\}/)[0];
    assert.match(content, /overflow-wrap: anywhere/, `${file} should wrap long runs`);
  }
});

const { nicknameLabel } = runPageScript('messages.js', {}, { expose: ['nicknameLabel'] });

test('ordinary nicknames are shown untouched', () => {
  assert.equal(nicknameLabel('根之声'), '根之声');
  assert.equal(nicknameLabel('RootedVox官方'), 'RootedVox官方');
});

test('an over-long nickname is shortened with an ellipsis for display', () => {
  const long = 'RootedVox官方(如果我改一个超级长的名字会怎么样abcdefghijklmnop)';
  const label = nicknameLabel(long);
  assert.equal(label.length, 20);
  assert.ok(label.endsWith('…'));
  assert.ok(long.startsWith(label.slice(0, 19)));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../forum-ui.js', import.meta.url), 'utf8');

// Runs forum-ui.js with a fake canvas. `encoded(type)` says what the browser's
// toBlob returns for a requested type: { type, size } or null.
async function upload(file, encoded, forms = []) {
  const sent = [];
  class FakeImage {
    width = 4000; height = 3000;
    set src(_) { queueMicrotask(() => this.onload()); }
  }
  const canvas = {
    getContext: () => ({ drawImage() {}, fillRect() {} }),
    toBlob(done, type) {
      const result = encoded(type);
      done(result && new Blob([new Uint8Array(result.size)], { type: result.type }));
    }
  };
  const window = {};
  vm.runInNewContext(source, {
    window, Image: FakeImage, File, Blob, FormData, Response, queueMicrotask,
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    document: { createElement: () => canvas, addEventListener() {} },
    request: async (_, { body }) => {
      sent.push(...body.getAll('files'));
      forms.push(body);
      return Response.json({ urls: ['https://db.example/x'] });
    }
  });
  await window.ForumUI.uploadFiles([file]);
  return sent[0];
}

const photo = (type, size) => new File([new Uint8Array(size)], 'photo.' + type.split('/')[1], { type });

test('browsers that export WebP upload the compressed WebP', async () => {
  const sent = await upload(photo('image/jpeg', 2_000_000), type => ({ type, size: 300_000 }));
  assert.equal(sent.type, 'image/webp');
  assert.equal(sent.name, 'photo.webp');
});

test('Safari, which hands back PNG for WebP, uploads photos as JPEG instead', async () => {
  const safari = type => type === 'image/webp' || type === 'image/png'
    ? { type: 'image/png', size: 3_500_000 } : { type, size: 400_000 };
  const sent = await upload(photo('image/jpeg', 2_000_000), safari);
  assert.equal(sent.type, 'image/jpeg');
  assert.equal(sent.size, 400_000);
  assert.equal(sent.name, 'photo.jpg');
});

test('a PNG source keeps PNG (it may be transparent) and never grows', async () => {
  const safari = () => ({ type: 'image/png', size: 3_000_000 });
  const kept = await upload(photo('image/png', 2_000_000), safari);
  assert.equal(kept.type, 'image/png');
  assert.equal(kept.size, 2_000_000);
  assert.equal(kept.name, 'photo.png');
  const smaller = await upload(photo('image/png', 2_000_000), () => ({ type: 'image/png', size: 900_000 }));
  assert.equal(smaller.type, 'image/png');
  assert.equal(smaller.size, 900_000);
});

test('each upload carries a small JPEG thumbnail made on the device', async () => {
  const forms = [];
  await upload(photo('image/jpeg', 2_000_000), type => ({ type, size: 20_000 }), forms);
  const thumb = forms[0].get('thumb0');
  assert.equal(thumb.type, 'image/jpeg');
  assert.equal(thumb.size, 20_000);
});

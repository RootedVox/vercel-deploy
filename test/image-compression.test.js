import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../forum-ui.js', import.meta.url), 'utf8');

// Runs forum-ui.js with a fake canvas. `encoded(type)` says what the browser's
// toBlob returns for a requested type: { type, size } or null.
async function upload(file, encoded) {
  const sent = [];
  class FakeImage {
    width = 4000; height = 3000;
    set src(_) { queueMicrotask(() => this.onload()); }
  }
  const canvas = {
    getContext: () => ({ drawImage() {} }),
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
      return Response.json({ urls: ['https://db.example/x'] });
    }
  });
  await window.ForumUI.uploadFiles([file]);
  return sent[0];
}

const photo = (type, size) => new File([new Uint8Array(size)], 'photo.' + type.split('/')[1], { type });

test('a small BMP is converted to an accepted format even when encoding increases its size', async () => {
  const sent = await upload(photo('image/bmp', 1000), type => ({ type, size: 1200 }));
  assert.equal(sent.type, 'image/webp');
  assert.equal(sent.name, 'photo.webp');
  assert.equal(sent.size, 1200);
});

test('a small image that cannot be converted reports the encoding error', async () => {
  await assert.rejects(upload(photo('image/avif', 1000), () => null), /图片压缩失败/);
});

test('small images in accepted formats are sent unchanged', async () => {
  for (const type of ['image/jpeg', 'image/png', 'image/gif', 'image/webp']) {
    const file = photo(type, 1000);
    const sent = await upload(file, () => assert.fail('small supported image was re-encoded'));
    assert.equal(sent.name, file.name);
    assert.equal(sent.type, file.type);
    assert.deepEqual(await sent.arrayBuffer(), await file.arrayBuffer());
  }
});

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

// Two-frame images with trailing padding to exercise the normal compression threshold.
const animations = {
  gif: 'R0lGODlhAgACAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQADwAAACwAAAAAAgACAAAIBgABCAQQEAAh+QQBDwABACwAAAAAAgACAIEAAP8AAAAAAAAAAAAIBgABCAQQEAA7',
  webp: 'UklGRoQAAABXRUJQVlA4WAoAAAACAAAAAQAAAQAAQU5JTQYAAAAAAAAAAABBTk1GKAAAAAAAAAAAAAEAAAEAAJYAAAJWUDhMDwAAAC8BQAAABxD9j/4HIqL/AQBBTk1GKAAAAAAAAAAAAAEAAAEAAJYAAABWUDhMDwAAAC8BQAAABxDR//4HIqL/AQA=',
  png: 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACGFjVEwAAAACAAAAAPONk3AAAAAaZmNUTAAAAAAAAAACAAAAAgAAAAAAAAAAAAMAFAAAhCwBGgAAABBJREFUeJxj/M8AAkxgkgEADR0BA4LJcf8AAAAaZmNUTAAAAAEAAAACAAAAAgAAAAAAAAAAAAMAFAAAH1/rzgAAABZmZEFUAAAAAnicY2Rg+M/AwMDEAAYACx8BAyVgX34AAAAASUVORK5CYII=',
};

test('message uploads preserve animation above the compression threshold', async () => {
  for (const [format, data] of Object.entries(animations)) {
    const types = format === 'png' ? ['image/png', 'image/apng'] : ['image/' + format];
    for (const type of types) {
      const file = new File([Buffer.from(data, 'base64'), new Uint8Array(102400)], 'motion.' + format, { type });
      const sent = await upload(file, () => assert.fail(type + ' was flattened by canvas'));
      assert.equal(sent.type, 'image/' + format);
      assert.deepEqual(await sent.arrayBuffer(), await file.arrayBuffer());
    }
  }
});

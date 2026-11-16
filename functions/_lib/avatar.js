// Avatars are 256px WebP images: the avatar editor exports them and the avatars bucket
// stores WebP to keep them small. Workers cannot decode WebP, so the server checks the
// container instead of trusting the multipart MIME label: a well-formed RIFF/WebP file,
// one still image (no animation), the exact 256x256 size in the bitstream header, and
// no chunk running past the end of the file.
export const AVATAR_SIZE = 256;
export const AVATAR_LIMIT = 64;
export const AVATAR_RETENTION_MS = 7 * 86400000;
export const AVATAR_MAX_BYTES = 1024 * 1024;

const fail = () => { throw new Error('invalid_avatar_image'); };
const fourcc = (bytes, offset) => String.fromCharCode(...bytes.subarray(offset, offset + 4));

// Returns the width and height stored in a VP8 (lossy) or VP8L (lossless) bitstream.
function bitstreamSize(type, data) {
  if (type === 'VP8 ') {
    // 3-byte frame tag (key frame bit clear, shown), start code, then 14-bit sizes
    // whose top two bits are a scaling mode that must be off.
    if (data.length < 10 || (data[0] & 1) !== 0 || !(data[0] & 0x10)) fail();
    if (data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) fail();
    const partition = (data[0] | data[1] << 8 | data[2] << 16) >>> 5;
    if (partition === 0 || partition > data.length - 10) fail();
    const width = data[6] | data[7] << 8, height = data[8] | data[9] << 8;
    if (width >> 14 || height >> 14) fail();
    return [width, height];
  }
  // VP8L: signature byte, then width-1 and height-1 in 14 bits each, an alpha hint
  // and a 3-bit version that must be zero.
  if (data.length < 5 || data[0] !== 0x2f) fail();
  const bits = (data[1] | data[2] << 8 | data[3] << 16 | data[4] << 24) >>> 0;
  if (bits >>> 29) fail();
  return [(bits & 0x3fff) + 1, (bits >>> 14 & 0x3fff) + 1];
}

export async function validateAvatar(file) {
  if (file.type !== 'image/webp' || file.size < 26 || file.size > AVATAR_MAX_BYTES) fail();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (fourcc(bytes, 0) !== 'RIFF' || fourcc(bytes, 8) !== 'WEBP') fail();
  if (view.getUint32(4, true) + 8 !== bytes.length) fail();

  const chunks = [];
  for (let offset = 12; offset < bytes.length;) {
    if (offset + 8 > bytes.length) fail();
    const size = view.getUint32(offset + 4, true);
    const end = offset + 8 + size;
    if (end > bytes.length) fail();
    chunks.push({ type: fourcc(bytes, offset), data: bytes.subarray(offset + 8, end) });
    // Chunks are padded to an even length.
    offset = end + (size & 1);
    if (offset > bytes.length) fail();
  }
  const types = chunks.map(chunk => chunk.type);

  let image;
  if (types.length === 1 && ['VP8 ', 'VP8L'].includes(types[0])) {
    image = chunks[0];
  } else {
    // Extended format, still image only: VP8X, optional ICCP, optional ALPH (lossy only),
    // the image, then optional EXIF and XMP metadata. Anything else, animation included,
    // is refused.
    if (!/^VP8X(?:ICCP)?(?:ALPHVP8 |VP8 |VP8L)(?:EXIF)?(?:XMP )?$/.test(types.join(''))) fail();
    const header = chunks[0].data;
    if (header.length !== 10 || header[0] & 0x02) fail();
    const width = (header[4] | header[5] << 8 | header[6] << 16) + 1;
    const height = (header[7] | header[8] << 8 | header[9] << 16) + 1;
    if (width !== AVATAR_SIZE || height !== AVATAR_SIZE) fail();
    image = chunks.find(chunk => chunk.type === 'VP8 ' || chunk.type === 'VP8L');
  }
  const [width, height] = bitstreamSize(image.type, image.data);
  if (width !== AVATAR_SIZE || height !== AVATAR_SIZE) fail();

  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

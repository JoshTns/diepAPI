/**
 * Obfuscated-float codec used by diep.wasm to store some f32 values (camera, scale, entity positions).
 *
 * Transcribed from the build with ETag W/"2c97e3dbbead03d69bbb5b686f86bd3c" (fetched 2026-11-10):
 * - decode: wasm func 979 (getter for an entity's +164 field) and the inlined copies of it
 * - encode: the store sites in wasm func 114 (entity position update)
 * decode(encode(x)) === x was checked for 2,000,000 random bit patterns.
 * The scheme changes between game builds, so re-check it after every diep.io update.
 */

/**
 * Encode raw f32 bits into the obfuscated u32 the game stores.
 */
export function encode(floatBits: number): number {
  const v = floatBits >>> 0;
  const a = (v >>> 16) ^ -20;
  const l3 = v ^ 106;
  const l4 = (Math.imul(l3, -54) + (l3 + ((v >>> 8) ^ -122)) + 59) | 0;
  const l5 = (a + l4 + Math.imul(l4, -69)) | 0;
  const l1 = (l5 + 124) | 0;
  const low = (((v >>> 24) ^ 80) + l1 + Math.imul(l5, -36) - 4431) & 255;
  return ((l1 << 24) | ((l4 & 255) << 16) | (((l3 + 28) & 255) << 8) | low) >>> 0;
}

/**
 * Decode an obfuscated u32 back into raw f32 bits.
 */
export function decode(encoded: number): number {
  const x = encoded >>> 0;
  const b3 = x >>> 24;
  const l2 = x >>> 16;
  const l3 = (x & 0xff00) >>> 8;
  const top = ((Math.imul(b3, 35) + x) >>> 0) << 24;
  const byte1 = (((l2 + Math.imul(l3 | (x << 8), 53) - 7) ^ 134) & 255) << 8;
  const byte0 = ((l3 - 28) ^ 106) & 255;
  const byte2 = (((b3 + Math.imul(l2, 68)) << 16) + 0x840000) & 0xff0000;
  const combined = (top | byte1 | byte0 | byte2) >>> 0;
  return (((combined - 0x21000000) >>> 0) ^ 0x50ec0000) >>> 0;
}

/**
 * Encode a float value into its obfuscated representation.
 */
export function encodeFloat(v: number): number {
  return encode(f32ToU32(v));
}

/**
 * Decode an obfuscated integer back into its float representation.
 */
export function decodeFloat(e: number): number {
  return u32ToF32(decode(e));
}

function f32ToU32(f: number): number {
  return new Uint32Array(new Float32Array([f]).buffer)[0];
}
function u32ToF32(u: number): number {
  return new Float32Array(new Uint32Array([u]).buffer)[0];
}

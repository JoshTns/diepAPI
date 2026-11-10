/**
 * Signature resolver for diep.wasm.
 *
 * Finds the camera object, its field offsets, the canvas-size addresses and the float decoder from
 * the module bytes at load time, so a game update doesn't need new hard-coded addresses.
 *
 * It anchors on the game's screen-to-world conversion, which exists once per axis:
 *   call <getter> ; local.set L
 *   ... i32.const <canvasDim> ; i32.load ; f64.convert_i32_s ; f64.const -0.5 ; f64.mul ; f64.add ...
 *   local.get L ; i32.load offset=<scale>  <decode>  f32.div
 *   local.get L ; i32.load offset=<cam>    <decode>  f32.add
 * The getter's body ends in `i32.const <base> ; end`, which gives the camera object's address.
 *
 * The decoder is built by copying the game's own decode instructions into a tiny module that
 * imports the game's memory, so changed scrambling constants are picked up automatically.
 * Validated against the build with ETag W/"2c97e3dbbead03d69bbb5b686f86bd3c" (2026-11-10), plus a
 * mutation test (moved object, moved offsets, changed XOR key).
 */

const OP = {
  LOCAL_GET: 0x20,
  LOCAL_SET: 0x21,
  LOCAL_TEE: 0x22,
  I32_CONST: 0x41,
  I32_LOAD: 0x28,
  F32_REINTERPRET_I32: 0xbe,
  F32_DIV: 0x95,
  F32_ADD: 0x92,
  F64_ADD: 0xa0,
  F64_CONVERT_I32_S: 0xb7,
  CALL: 0x10,
  END: 0x0b,
} as const;

/** i32 arithmetic ops without immediates that may appear inside a decode sequence. */
const I32_ARITH = new Set([0x6a, 0x6b, 0x6c, 0x71, 0x72, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78]);

/** f64.const -0.5 ; f64.mul */
const HALF_ANCHOR = [0x44, 0, 0, 0, 0, 0, 0, 0xe0, 0xbf, 0xa2];

type Leb = [value: number, next: number];

function uleb(b: Uint8Array, i: number): Leb {
  let r = 0;
  let s = 0;
  let x: number;
  do {
    x = b[i++];
    r += (x & 0x7f) * 2 ** s;
    s += 7;
  } while (x & 0x80);
  return [r, i];
}

function sleb(b: Uint8Array, i: number): Leb {
  let r = 0;
  let s = 0;
  let x: number;
  do {
    x = b[i++];
    r |= (x & 0x7f) << s;
    s += 7;
  } while (x & 0x80 && s < 35);
  if (s < 32 && x & 0x40) r |= -1 << s;
  return [r | 0, i];
}

function ulebBytes(v: number): number[] {
  const out: number[] = [];
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v) byte |= 0x80;
    out.push(byte);
  } while (v);
  return out;
}

interface Body {
  start: number;
  end: number;
}

interface ParsedModule {
  importedFuncs: number;
  bodies: Body[];
  code: Body;
}

function parseModule(b: Uint8Array): ParsedModule {
  if (b[0] !== 0 || b[1] !== 0x61 || b[2] !== 0x73 || b[3] !== 0x6d) {
    throw new Error('diepAPI: not a wasm module');
  }
  let i = 8;
  let importedFuncs = 0;
  let code: Body | null = null;
  while (i < b.length) {
    const id = b[i];
    const [size, start] = uleb(b, i + 1);
    if (id === 2) {
      const [n, k0] = uleb(b, start);
      let k = k0;
      for (let j = 0; j < n; j++) {
        let len: number;
        [len, k] = uleb(b, k);
        k += len;
        [len, k] = uleb(b, k);
        k += len;
        const kind = b[k++];
        if (kind === 0) {
          importedFuncs++;
          [, k] = uleb(b, k);
        } else if (kind === 1) {
          k++;
          const fl = b[k++];
          [, k] = uleb(b, k);
          if (fl & 1) [, k] = uleb(b, k);
        } else if (kind === 2) {
          const fl = b[k++];
          [, k] = uleb(b, k);
          if (fl & 1) [, k] = uleb(b, k);
        } else if (kind === 3) {
          k += 2;
        } else if (kind === 4) {
          k++;
          [, k] = uleb(b, k);
        }
      }
    }
    if (id === 10) code = { start, end: start + size };
    i = start + size;
  }
  if (!code) throw new Error('diepAPI: wasm has no code section');

  const bodies: Body[] = [];
  const [n, k0] = uleb(b, code.start);
  let k = k0;
  for (let j = 0; j < n; j++) {
    const [size, s] = uleb(b, k);
    bodies.push({ start: s, end: s + size });
    k = s + size;
  }
  return { importedFuncs, bodies, code };
}

interface DecodeSeq {
  /** index just past f32.reinterpret_i32 */
  end: number;
  /** the i32.load's offset immediate */
  offset: number;
  /** first byte after the i32.load immediates */
  bodyStart: number;
  /** highest local index referenced inside the sequence */
  maxLocal: number;
}

/** Walk a decode sequence starting at an `i32.load` opcode. */
function walkDecode(b: Uint8Array, i: number): DecodeSeq | null {
  if (b[i] !== OP.I32_LOAD) return null;
  let offset: number;
  [, i] = uleb(b, i + 1); // align
  [offset, i] = uleb(b, i);
  const bodyStart = i;
  if (b[i] !== OP.LOCAL_TEE) return null;
  let maxLocal = -1;
  let ops = 0;
  while (i < b.length && ops < 120) {
    const op = b[i++];
    ops++;
    if (op === OP.F32_REINTERPRET_I32) {
      return ops >= 20 ? { end: i, offset, bodyStart, maxLocal } : null;
    }
    if (op === OP.LOCAL_GET || op === OP.LOCAL_SET || op === OP.LOCAL_TEE) {
      let idx: number;
      [idx, i] = uleb(b, i);
      maxLocal = Math.max(maxLocal, idx);
    } else if (op === OP.I32_CONST) {
      [, i] = sleb(b, i);
    } else if (!I32_ARITH.has(op)) {
      return null;
    }
  }
  return null;
}

/** The constant a lazy-init singleton getter returns (`... i32.const C ; end`), or null. */
function getterConstant(b: Uint8Array, body: Body): number | null {
  if (b[body.end - 1] !== OP.END) return null;
  for (let k = body.end - 7; k <= body.end - 3; k++) {
    if (b[k] !== OP.I32_CONST) continue;
    const [v, e] = sleb(b, k + 1);
    if (e === body.end - 1) return v;
  }
  return null;
}

interface Site {
  canvasDim: number;
  getter: number;
  scaleOff: number;
  camOff: number;
  decode: DecodeSeq;
}

function matchesAt(b: Uint8Array, i: number, pattern: readonly number[]): boolean {
  for (let j = 0; j < pattern.length; j++) if (b[i + j] !== pattern[j]) return false;
  return true;
}

function findSites(b: Uint8Array, mod: ParsedModule): Site[] {
  const sites: Site[] = [];
  const { code } = mod;
  for (let i = code.start + 16; i < code.end - 64; i++) {
    if (b[i] !== 0x44 || !matchesAt(b, i, HALF_ANCHOR)) continue;

    // i32.const C ; i32.load 2 0 ; f64.convert_i32_s right before the anchor
    if (
      b[i - 1] !== OP.F64_CONVERT_I32_S ||
      b[i - 2] !== 0x00 ||
      b[i - 3] !== 0x02 ||
      b[i - 4] !== OP.I32_LOAD
    ) {
      continue;
    }
    let canvasDim: number | null = null;
    for (let k = i - 9; k <= i - 6; k++) {
      if (b[k] !== OP.I32_CONST) continue;
      const [v, e] = sleb(b, k + 1);
      if (e === i - 4) {
        canvasDim = v;
        break;
      }
    }
    if (canvasDim === null) continue;

    let p = i + HALF_ANCHOR.length;
    if (b[p++] !== OP.F64_ADD) continue;
    for (let tries = 0; b[p] !== OP.LOCAL_GET && tries < 4; tries++) p++;
    if (b[p] !== OP.LOCAL_GET) continue;
    let local: number;
    [local, p] = uleb(b, p + 1);

    const dScale = walkDecode(b, p);
    if (!dScale || b[dScale.end] !== OP.F32_DIV) continue;
    p = dScale.end + 1;
    if (b[p] !== OP.LOCAL_GET) continue;
    let local2: number;
    [local2, p] = uleb(b, p + 1);
    if (local2 !== local) continue;
    const dCam = walkDecode(b, p);
    if (!dCam || b[dCam.end] !== OP.F32_ADD) continue;

    // `call F ; local.set L` somewhere shortly before
    const setL = [OP.LOCAL_SET, ...ulebBytes(local)];
    let getter: number | null = null;
    for (let k = i - 4; k > i - 200 && k > code.start; k--) {
      if (b[k] !== OP.CALL) continue;
      const [f, e] = uleb(b, k + 1);
      if (matchesAt(b, e, setL)) {
        getter = f;
        break;
      }
    }
    if (getter === null) continue;

    sites.push({ canvasDim, getter, scaleOff: dScale.offset, camOff: dCam.offset, decode: dScale });
  }
  return sites;
}

/** Build a module exporting `d(addr: i32) -> f32` from the game's decode bytes. Imports memory `e.m`. */
function buildDecoderModule(b: Uint8Array, d: DecodeSeq): Uint8Array<ArrayBuffer> {
  const body: number[] = [];
  const extraLocals = d.maxLocal; // local 0 is the address param; 1..maxLocal are i32 temps
  if (extraLocals > 0) body.push(1, ...ulebBytes(extraLocals), 0x7f);
  else body.push(0);
  body.push(OP.LOCAL_GET, 0, OP.I32_LOAD, 2, 0);
  for (let k = d.bodyStart; k < d.end; k++) body.push(b[k]);
  body.push(OP.END);

  const sec = (id: number, bytes: number[]) => [id, ...ulebBytes(bytes.length), ...bytes];
  const str = (s: string) => [...ulebBytes(s.length), ...Array.from(s, (c) => c.charCodeAt(0))];
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    ...sec(1, [1, 0x60, 1, 0x7f, 1, 0x7d]), // type: (i32) -> f32
    ...sec(2, [1, ...str('e'), ...str('m'), 0x02, 0x00, 1]), // import memory e.m, min 1 page
    ...sec(3, [1, 0]),
    ...sec(7, [1, ...str('d'), 0x00, 0]),
    ...sec(10, [1, ...ulebBytes(body.length), ...body]),
  ]);
}

export interface ResolvedLayout {
  cameraBase: number;
  /** encoded f32 */
  cameraX: number;
  /** encoded f32 */
  cameraY: number;
  /** encoded f32, canvas pixels per arena unit */
  scale: number;
  /** i32 */
  canvasWidth: number;
  /** i32 */
  canvasHeight: number;
  offsets: { cameraX: number; cameraY: number; scale: number };
  decoderBytes: Uint8Array<ArrayBuffer>;
}

/**
 * Resolve the camera layout from the game's wasm bytes. Throws with a descriptive message if the
 * expected code shape isn't found (e.g. the game changed how it computes screen-to-world).
 */
export function resolveLayout(bytes: Uint8Array): ResolvedLayout {
  const mod = parseModule(bytes);
  const sites = findSites(bytes, mod);
  if (sites.length !== 2) {
    throw new Error(`diepAPI: expected 2 screen-to-world sites, found ${sites.length}`);
  }
  const [a, c] = sites;
  if (a.getter !== c.getter || a.scaleOff !== c.scaleOff) {
    throw new Error('diepAPI: screen-to-world sites disagree on camera object/scale');
  }
  // width is stored right before height, so the site with the smaller address is X
  const [x, y] = a.canvasDim < c.canvasDim ? [a, c] : [c, a];
  if (y.canvasDim - x.canvasDim !== 4) throw new Error('diepAPI: canvas width/height not adjacent');

  const bodyIndex = a.getter - mod.importedFuncs;
  if (bodyIndex < 0 || bodyIndex >= mod.bodies.length) {
    throw new Error('diepAPI: camera getter is not a module function');
  }
  const cameraBase = getterConstant(bytes, mod.bodies[bodyIndex]);
  if (cameraBase === null) throw new Error('diepAPI: camera getter does not return a constant');

  return {
    cameraBase,
    cameraX: cameraBase + x.camOff,
    cameraY: cameraBase + y.camOff,
    scale: cameraBase + a.scaleOff,
    canvasWidth: x.canvasDim,
    canvasHeight: y.canvasDim,
    offsets: { cameraX: x.camOff, cameraY: y.camOff, scale: a.scaleOff },
    decoderBytes: buildDecoderModule(bytes, a.decode),
  };
}

/** Instantiate the generated decoder against the game's memory: returns decodeAt(addr) -> number. */
export function makeDecoder(decoderBytes: Uint8Array<ArrayBuffer>, memory: WebAssembly.Memory): (addr: number) => number {
  const module = new WebAssembly.Module(decoderBytes);
  const instance = new WebAssembly.Instance(module, { e: { m: memory } });
  return instance.exports.d as (addr: number) => number;
}

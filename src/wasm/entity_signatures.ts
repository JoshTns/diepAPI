/**
 * Signature resolver for the game's entity storage.
 *
 * Found statically in the build with ETag W/"2c97e3dbbead03d69bbb5b686f86bd3c" (2026-11-10):
 * - world registry: u32[2048] of world pointers (registration fn uses the constant 2047 for wrap-around)
 * - registry lookup fn: loads from the registry, adds the pool offset to the world, calls the allocator
 * - allocator: page table at pool + P, 64 KB pages of 256-byte slots (constants 65536 and 256)
 * - motion component getters: `local.get 0; call <update>; local.get 0; i32.load K; <decode>` for X and Y
 * - shape radius fn: the only function with f32.const 1/sqrt(2); reads sides (i32) and size (encoded f32)
 *
 * In-slot offsets (world pointer, motion/shape/style/team components) are calibrated at runtime from
 * structural invariants by the memory entity manager, so they are not resolved here.
 */
import { parseModule, sleb, uleb, type Body } from './signatures';

interface Instr {
  op: number;
  /** first immediate (index, constant, or for memory ops the offset) */
  a: number;
  /** f32.const raw bits */
  bits?: number;
}

const BLOCK_TYPES = new Set([0x40, 0x7f, 0x7e, 0x7d, 0x7c, 0x7b, 0x70, 0x6f]);

/** Decode a function body into instructions. Throws on an opcode it does not know. */
function walkBody(b: Uint8Array, body: Body): Instr[] {
  let [nLocals, p] = uleb(b, body.start);
  for (; nLocals > 0; nLocals--) {
    [, p] = uleb(b, p);
    p++;
  }
  const out: Instr[] = [];
  while (p < body.end) {
    const op = b[p++];
    let a = 0;
    let bits: number | undefined;
    if (op === 0x02 || op === 0x03 || op === 0x04 || op === 0x06) {
      if (BLOCK_TYPES.has(b[p])) p++;
      else [, p] = sleb(b, p);
    } else if (
      op === 0x0c || op === 0x0d || op === 0x10 || (op >= 0x20 && op <= 0x26) ||
      op === 0xd2 || op === 0x07 || op === 0x08 || op === 0x09 || op === 0x18
    ) {
      [a, p] = uleb(b, p);
    } else if (op === 0x0e) {
      let n: number;
      [n, p] = uleb(b, p);
      for (let k = 0; k <= n; k++) [, p] = uleb(b, p);
    } else if (op === 0x11) {
      [a, p] = uleb(b, p);
      [, p] = uleb(b, p);
    } else if (op === 0x1c) {
      let n: number;
      [n, p] = uleb(b, p);
      p += n;
    } else if (op >= 0x28 && op <= 0x3e) {
      [, p] = uleb(b, p); // align
      [a, p] = uleb(b, p); // offset
    } else if (op === 0x3f || op === 0x40 || op === 0xd0) {
      p++;
    } else if (op === 0x41) {
      [a, p] = sleb(b, p);
    } else if (op === 0x42) {
      while (b[p++] & 0x80); // i64 LEB, value not needed
    } else if (op === 0x43) {
      bits = (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
      p += 4;
    } else if (op === 0x44) {
      p += 8;
    } else if (op === 0xfc) {
      [a, p] = uleb(b, p);
      if (a === 8) {
        [, p] = uleb(b, p);
        p++;
      } else if (a === 9 || a === 13 || a === 15 || a === 16 || a === 17) [, p] = uleb(b, p);
      else if (a === 10) p += 2;
      else if (a === 11) p += 1;
      else if (a === 12 || a === 14) {
        [, p] = uleb(b, p);
        [, p] = uleb(b, p);
      }
    } else if (
      !(op >= 0x45 && op <= 0xc4) &&
      op !== 0x00 && op !== 0x01 && op !== 0x05 && op !== 0x0b && op !== 0x0f && op !== 0x1a && op !== 0x1b && op !== 0xd1
    ) {
      throw new Error(`diepAPI: unknown wasm opcode 0x${op.toString(16)}`);
    }
    out.push(bits === undefined ? { op, a } : { op, a, bits });
  }
  return out;
}

const OP = {
  LOCAL_GET: 0x20, LOCAL_TEE: 0x22, CALL: 0x10, I32_LOAD: 0x28, I32_CONST: 0x41, I32_ADD: 0x6a,
  F32_CONST: 0x43, F32_REINTERPRET_I32: 0xbe, END: 0x0b,
} as const;
const INV_SQRT2_BITS = 0x3f3504f3;

export interface EntityLayout {
  /** address of the u32 world-pointer registry */
  registry: number;
  /** number of registry entries */
  registryCapacity: number;
  /** world + poolOffset = entity pool */
  poolOffset: number;
  /** pool + pageTableOffset + page * 4 = page pointer */
  pageTableOffset: number;
  pageBytes: number;
  slotStride: number;
  /** the two encoded coordinate offsets in the motion component (X/Y order decided at runtime) */
  motionCoords: [number, number];
  /** shape component: i32 side count */
  shapeSides: number;
  /** shape component: encoded size (radius = size for circles; see EntityShape) */
  shapeSize: number;
}

/** Resolve the entity storage layout from the module bytes. Throws with a reason when a step fails. */
export function resolveEntityLayout(bytes: Uint8Array): EntityLayout {
  const mod = parseModule(bytes);
  const funcs = new Map<number, Instr[]>();
  mod.bodies.forEach((body, i) => funcs.set(i + mod.importedFuncs, walkBody(bytes, body)));

  // 1. registry candidates: >= 3x `i32.const 2047`, and a big load offset that is also an i32.const
  const candidates: { fn: number; reg: number }[] = [];
  for (const [fn, ins] of funcs) {
    let c2047 = 0;
    const consts = new Set<number>();
    const loads = new Set<number>();
    for (const x of ins) {
      if (x.op === OP.I32_CONST) {
        consts.add(x.a);
        if (x.a === 2047) c2047++;
      } else if (x.op === OP.I32_LOAD && x.a > 65536) loads.add(x.a);
    }
    if (c2047 < 3) continue;
    for (const r of loads) if (consts.has(r)) candidates.push({ fn, reg: r });
  }
  if (candidates.length === 0) throw new Error('diepAPI: entity registry not found');

  // 2. the lookup fn loads from the registry and calls the allocator (65536 + 256 + a page-table load)
  let found: Omit<EntityLayout, 'motionCoords' | 'shapeSides' | 'shapeSize'> | null = null;
  for (const { fn: regFn, reg } of candidates) {
    for (const [fn, ins] of funcs) {
      if (fn === regFn || !ins.some((x) => x.op === OP.I32_LOAD && x.a === reg)) continue;
      for (const callee of new Set(ins.filter((x) => x.op === OP.CALL).map((x) => x.a))) {
        const ci = funcs.get(callee);
        if (!ci) continue;
        const consts = new Set(ci.filter((x) => x.op === OP.I32_CONST).map((x) => x.a));
        if (!consts.has(65536) || !consts.has(256)) continue;
        const pageLoads = [...new Set(ci.filter((x) => x.op === OP.I32_LOAD && x.a > 1024 && x.a < 65536).map((x) => x.a))];
        if (pageLoads.length !== 1) continue;
        // pool offset: local.get A ; i32.const k ; i32.add ; local.tee A
        const pool: number[] = [];
        for (let j = 0; j + 3 < ins.length; j++) {
          if (ins[j].op === OP.LOCAL_GET && ins[j + 1].op === OP.I32_CONST && ins[j + 2].op === OP.I32_ADD &&
              ins[j + 3].op === OP.LOCAL_TEE && ins[j + 3].a === ins[j].a && ins[j + 1].a > 0 && ins[j + 1].a < 256) {
            pool.push(ins[j + 1].a);
          }
        }
        if (pool.length < 1) continue;
        if (found) throw new Error('diepAPI: entity registry lookup is ambiguous');
        found = {
          registry: reg, registryCapacity: 2048, poolOffset: pool[0], pageTableOffset: pageLoads[0],
          pageBytes: 65536, slotStride: 256,
        };
      }
    }
  }
  if (!found) throw new Error('diepAPI: entity pool allocator not found');

  // 3. motion getters: local.get 0; call U; local.get 0; i32.load K; local.tee; i32.const 24 ... f32.reinterpret_i32; end
  const byUpdate = new Map<number, number[]>();
  for (const ins of funcs.values()) {
    if (ins.length < 10 || ins.length > 120) continue;
    const [g0, c, g1, ld, tee, k24] = ins;
    if (g0.op !== OP.LOCAL_GET || g0.a !== 0 || c.op !== OP.CALL || g1.op !== OP.LOCAL_GET || g1.a !== 0) continue;
    if (ld.op !== OP.I32_LOAD || tee.op !== OP.LOCAL_TEE || k24.op !== OP.I32_CONST || k24.a !== 24) continue;
    if (ins[ins.length - 1].op !== OP.END || ins[ins.length - 2].op !== OP.F32_REINTERPRET_I32) continue;
    byUpdate.set(c.a, [...(byUpdate.get(c.a) ?? []), ld.a]);
  }
  const coordGroups = [...byUpdate.values()].filter((offs) => new Set(offs).size === 2);
  if (coordGroups.length !== 1) throw new Error(`diepAPI: expected 1 motion getter pair, found ${coordGroups.length}`);
  const [c0, c1] = [...new Set(coordGroups[0])].sort((x, y) => x - y);

  // 4. shape radius fn: f32.const 1/sqrt(2); sides = load from local 0; size = local.get 0 + const
  const shapeFns: { sides: number; size: number }[] = [];
  for (const ins of funcs.values()) {
    if (ins.length > 600 || !ins.some((x) => x.op === OP.F32_CONST && x.bits === INV_SQRT2_BITS)) continue;
    if (!ins.some((x) => x.op === OP.I32_CONST && x.a === 3)) continue;
    const sides = new Set<number>();
    const size = new Set<number>();
    for (let j = 0; j + 2 < ins.length; j++) {
      if (ins[j].op !== OP.LOCAL_GET || ins[j].a !== 0) continue;
      if (ins[j + 1].op === OP.I32_LOAD) sides.add(ins[j + 1].a);
      if (ins[j + 1].op === OP.I32_CONST && ins[j + 2].op === OP.I32_ADD) size.add(ins[j + 1].a);
    }
    if (sides.size === 1 && size.size === 1) shapeFns.push({ sides: [...sides][0], size: [...size][0] });
  }
  if (shapeFns.length !== 1) throw new Error(`diepAPI: expected 1 shape radius fn, found ${shapeFns.length}`);

  return { ...found, motionCoords: [c0, c1], shapeSides: shapeFns[0].sides, shapeSize: shapeFns[0].size };
}

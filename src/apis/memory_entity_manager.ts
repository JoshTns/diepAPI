import { game } from './game';
import { Vector } from '../core';
import { Entity, EntityType } from '../types/entity';
import { layout, wasmInstance } from '../wasm';
import type { EntityLayout } from '../wasm/entity_signatures';

/** The game's colour ids. 3/4/8/9/10/11 were confirmed in live data; the rest follow the usual diep table. */
export const COLOR_HEX: Record<number, string> = {
  1: '#999999', 2: '#00b2e1', 3: '#00b2e1', 4: '#f14e54', 5: '#bf7ff5', 6: '#00e16e',
  8: '#ffe869', 9: '#fc7677', 10: '#768dfc', 11: '#f177dd', 15: '#f14e54', 16: '#fcc376',
};
const TEAM_COLOR_IDS = new Set([2, 3, 4, 5, 6, 15]);
const NEUTRAL_COLOR_IDS = new Set([8, 9, 10, 11]);
/** Defaults found for the 2026-11-10 build; calibration checks them first. */
const DEFAULT_COLOR = { slot: 196, word: 112 };
const DEFAULT_TEAM = { slot: 132, word: 44 };
/** Up to this many units between camera and tank (the camera trails the tank while moving). */
const OWN_TANK_RANGE = 150;

/** In-slot offsets found at runtime from structural invariants. */
export interface Calibration {
  worldId: number;
  worldOffset: number;
  motionOffset: number;
  shapeOffset: number;
  x: number;
  y: number;
  color: { slot: number; word: number } | null;
  team: { slot: number; word: number } | null;
  /** slot offsets of components only tanks have */
  tankMarkers: number[];
}

interface MemViews {
  u32: Uint32Array;
  rd: (a: number) => number;
  okPtr: (p: number) => boolean;
}

interface Row {
  key: string;
  e: number;
  x: number;
  y: number;
  sides: number;
  size: number;
  radius: number;
  colorId: number | undefined;
  team: number | undefined;
  isTank: boolean;
}

const radiusOf = (sides: number, size: number): number =>
  sides >= 6 ? size / Math.cos(Math.PI / sides) : sides >= 3 ? size / Math.SQRT1_2 : sides === 1 ? size : size * Math.SQRT2;

function classify(r: Row): EntityType | null {
  const { sides, colorId: c, radius } = r;
  if (sides === 1) return r.isTank ? EntityType.Player : EntityType.Bullet;
  if (sides === 3) {
    if (c === 9) return EntityType.Triangle;
    if (c === 11) return EntityType.Crasher;
    if (c !== undefined && TEAM_COLOR_IDS.has(c)) return EntityType.Drone;
    return EntityType.UNKNOWN;
  }
  if (sides === 4) {
    if (c === 8) return EntityType.Square;
    if (c !== undefined && (TEAM_COLOR_IDS.has(c) || c === 16)) return EntityType.Drone;
    return EntityType.UNKNOWN;
  }
  if (sides === 5) return radius > 150 ? EntityType.AlphaPentagon : EntityType.Pentagon;
  if (sides === 6) return EntityType.Hexagon;
  if (sides === 2) return null; // rectangles: barrels and team bases are skipped
  return EntityType.UNKNOWN;
}

/**
 * Entity manager that reads the game's own entity pool from wasm memory instead of inferring
 * entities from draw calls. Same API shape as `entityManager` (entities, getPlayer()), with stable
 * ids (pool slots), the game's type data (side count, colour id, team) and entities just off screen.
 *
 * Velocity is computed from the drawn position once per rendered frame (time-weighted, 10 frames),
 * which matched the canvas manager to ~0.2 u/s in live recordings.
 */
class MemoryEntityManager {
  #entities: Entity[] = [];
  #bySlot = new Map<string, Entity>();
  #cal: Calibration | null = null;
  #lastError: string | null = null;
  #enabled = true;
  #xyAttempts = 0;
  /** consecutive frames in which no entity moved (shapes always drift, so this means a bad calibration) */
  #frozenFrames = 0;

  constructor() {
    game.on('render_start', () => {
      if (!this.#enabled) return;
      try {
        this.#frame();
      } catch (e) {
        this.#setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  /** Entities of the last rendered frame. Empty until the layout is resolved and calibrated. */
  get entities(): Entity[] {
    return this.#entities;
  }

  /** True once the entity layout is resolved and the in-slot offsets are calibrated. */
  get ready(): boolean {
    return this.#cal !== null;
  }

  get calibration(): Calibration | null {
    return this.#cal;
  }

  /** Last reason the manager could not produce entities (null when it is working). */
  get error(): string | null {
    return this.#lastError;
  }

  /** Stop/start walking memory each frame. */
  set enabled(v: boolean) {
    this.#enabled = v;
  }

  /** The own tank: the tank nearest to the camera (within 150 units). */
  getPlayer(): Entity | undefined {
    const addr = layout.addresses;
    if (addr === null) return undefined;
    const cam = new Vector(layout.decodeAt(addr.cameraX), layout.decodeAt(addr.cameraY));
    let best: Entity | undefined;
    let bestDist = OWN_TANK_RANGE;
    for (const e of this.#entities) {
      if (e.type !== EntityType.Player) continue;
      const d = Vector.distance(e.position, cam);
      if (d < bestDist) {
        bestDist = d;
        best = e;
      }
    }
    return best;
  }

  /** Force recalibration (e.g. after the game reloads its arena world). */
  recalibrate(): void {
    this.#cal = null;
    this.#xyAttempts = 0;
    this.#bySlot.clear();
  }

  #setError(msg: string): void {
    if (msg !== this.#lastError) console.warn('diepAPI memoryEntityManager:', msg);
    this.#lastError = msg;
  }

  // ---------- memory access ----------

  #views(): MemViews | null {
    const mem = wasmInstance.memory;
    if (!mem) return null;
    const u32 = new Uint32Array(mem.buffer);
    const size = mem.buffer.byteLength;
    return {
      u32,
      rd: (a: number) => u32[a >>> 2],
      okPtr: (p: number) => p > 1024 && p + 256 < size && (p & 3) === 0,
    };
  }

  /** Arena worlds: those whose root pointer (world + 8) is the camera object. */
  #arenaWorlds(L: EntityLayout, v: MemViews, cameraBase: number) {
    const out: { id: number; w: number }[] = [];
    for (let id = 0; id < L.registryCapacity; id++) {
      const w = v.rd(L.registry + id * 4);
      if (v.okPtr(w) && v.rd(w + 8) === cameraBase) out.push({ id, w });
    }
    return out;
  }

  *#slots(L: EntityLayout, v: MemViews, w: number) {
    const pool = w + L.poolOffset;
    const perPage = L.pageBytes / L.slotStride;
    const maxPages = 256;
    for (let p = 0; p < maxPages; p++) {
      const page = v.rd(pool + L.pageTableOffset + p * 4);
      if (!v.okPtr(page)) continue;
      for (let s = 0; s < perPage; s++) yield { slot: p * perPage + s, e: page + s * L.slotStride };
    }
  }

  // ---------- calibration ----------

  #calibrate(L: EntityLayout): Calibration | string {
    const v = this.#views();
    const addr = layout.addresses;
    if (!v || !addr) return 'wasm memory not available';
    const worlds = this.#arenaWorlds(L, v, addr.cameraBase);
    if (worlds.length === 0) return 'no arena world yet (not in a game?)';
    const { id: worldId, w } = worlds[worlds.length - 1];

    // world back-pointer offset: the word equal to the world pointer in most non-empty slots
    const slots: number[] = [];
    for (const { e } of this.#slots(L, v, w)) {
      for (let k = 0; k < L.slotStride; k += 4) {
        if (v.rd(e + k)) {
          slots.push(e);
          break;
        }
      }
    }
    if (slots.length < 16) return 'arena world has too few slots to calibrate';
    const argmax = (count: (k: number) => number, exclude: number[] = []) => {
      let best = -1;
      let bestN = 0;
      let second = 0;
      for (let k = 0; k < L.slotStride; k += 4) {
        if (exclude.includes(k)) continue;
        const n = count(k);
        if (n > bestN) {
          second = bestN;
          bestN = n;
          best = k;
        } else if (n > second) second = n;
      }
      return { k: best, n: bestN, second };
    };
    const wo = argmax((k) => slots.reduce((n, e) => n + (v.rd(e + k) === w ? 1 : 0), 0));
    if (wo.n < slots.length * 0.3) return 'world back-pointer not found in slots';
    const owned = slots.filter((e) => v.rd(e + wo.k) === w);

    // motion component. Every component starts with a pointer back to its owner slot, so that alone
    // is not enough: the motion component is the one whose coordinate fields (offsets from the code
    // signature) hold plausible, distinct arena positions across entities.
    const [m0, m1] = L.motionCoords;
    const plausible = (p: number) => {
      const a = layout.decodeAt(p + m0);
      const b = layout.decodeAt(p + m1);
      if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) > 30000 || Math.abs(b) > 30000) return null;
      if (Math.abs(a) < 1e-3 && Math.abs(b) < 1e-3) return null;
      return `${a.toFixed(1)},${b.toFixed(1)}`;
    };
    const motionScore = (k: number) => {
      const distinct = new Set<string>();
      for (const e of owned) {
        const p = v.rd(e + k);
        if (!v.okPtr(p) || v.rd(p) !== e) continue;
        const key = plausible(p);
        if (key !== null) distinct.add(key);
      }
      return distinct.size;
    };
    const mo = argmax(motionScore, [wo.k]);
    if (mo.n < 5) return 'motion component not found (too few entities?)';
    if (mo.second > mo.n * 0.5) return 'motion component ambiguous';
    const ents = owned.filter((e) => {
      const p = v.rd(e + mo.k);
      return v.okPtr(p) && v.rd(p) === e && plausible(p) !== null;
    });

    // X/Y: which coordinate pair is (x, y). Two signals that work even when camX ~ camY (spawn corners):
    //  1. the own tank is within ~60 units of the camera; swapped, the nearest entity is ~|camX - camY| * 1.4 away
    //  2. the view is wider than tall: count entities inside the visible box both ways round
    const camX = layout.decodeAt(addr.cameraX);
    const camY = layout.decodeAt(addr.cameraY);
    const scale = layout.decodeAt(addr.scale);
    const halfW = (v.rd(addr.canvasWidth) / 2 / scale) * 1.15;
    const halfH = (v.rd(addr.canvasHeight) / 2 / scale) * 1.15;
    const [c0, c1] = L.motionCoords;
    const score = (kx: number, ky: number) => {
      let nearest = Infinity;
      let visible = 0;
      for (const e of ents) {
        const m = v.rd(e + mo.k);
        const dx = layout.decodeAt(m + kx) - camX;
        const dy = layout.decodeAt(m + ky) - camY;
        nearest = Math.min(nearest, Math.hypot(dx, dy));
        if (Math.abs(dx) <= halfW && Math.abs(dy) <= halfH) visible++;
      }
      return { nearest, visible };
    };
    const a = score(c0, c1);
    const b = score(c1, c0);
    const margin = Math.max(2, Math.round(ents.length * 0.1));
    let order: 'ab' | 'ba' | null = null;
    if (a.nearest < 150 && b.nearest > 2 * a.nearest + 100) order = 'ab';
    else if (b.nearest < 150 && a.nearest > 2 * b.nearest + 100) order = 'ba';
    else if (Number.isFinite(halfW) && halfW > 0 && a.visible >= b.visible + margin) order = 'ab';
    else if (Number.isFinite(halfW) && halfW > 0 && b.visible >= a.visible + margin) order = 'ba';
    else if (++this.#xyAttempts > 250) {
      console.warn('diepAPI memoryEntityManager: X/Y still ambiguous after ~5 s; assuming the lower offset is X');
      order = 'ab';
    }
    if (order === null) return 'cannot tell X from Y yet (move a little away from the map diagonal)';
    const [x, y] = order === 'ab' ? [c0, c1] : [c1, c0];

    // shape component: a pointer whose block has a plausible side count and size
    const shapeOk = (p: number) => {
      if (!v.okPtr(p)) return false;
      const sides = v.rd(p + L.shapeSides);
      const size = layout.decodeAt(p + L.shapeSize);
      return sides >= 1 && sides <= 16 && Number.isFinite(size) && size > 1 && size < 2000;
    };
    const so = argmax((k) => ents.reduce((n, e) => n + (shapeOk(v.rd(e + k)) ? 1 : 0), 0), [wo.k, mo.k]);
    if (so.n < ents.length * 0.7 || so.second >= so.n) return 'shape component not found';

    const shape = (e: number) => {
      const p = v.rd(e + so.k);
      const sides = v.rd(p + L.shapeSides);
      return { sides, radius: radiusOf(sides, layout.decodeAt(p + L.shapeSize)) };
    };
    const squares = ents.filter((e) => { const s = shape(e); return s.sides === 4 && Math.abs(s.radius - 55) < 2; });
    const triangles = ents.filter((e) => { const s = shape(e); return s.sides === 3 && Math.abs(s.radius - 55) < 2; });

    // colour: a (component, word) that reads 8 on squares and 9 on triangles
    const readWord = (e: number, slotOff: number, word: number) => {
      const p = v.rd(e + slotOff);
      return v.okPtr(p) ? v.rd(p + word) : undefined;
    };
    const colorFits = (slotOff: number, word: number) => {
      const sq = squares.filter((e) => readWord(e, slotOff, word) === 8).length;
      const tr = triangles.filter((e) => readWord(e, slotOff, word) === 9).length;
      return sq >= squares.length * 0.8 && tr >= triangles.length * 0.8;
    };
    let color: Calibration['color'] = null;
    if (squares.length >= 2 && triangles.length >= 1) {
      if (colorFits(DEFAULT_COLOR.slot, DEFAULT_COLOR.word)) color = DEFAULT_COLOR;
      else {
        search: for (let s = 0; s < L.slotStride; s += 4) {
          if (s === wo.k) continue;
          for (let wd = 0; wd < 256; wd += 4) {
            if (colorFits(s, wd)) {
              color = { slot: s, word: wd };
              break search;
            }
          }
        }
      }
    }

    // team: neutral shapes all share one value, and some team-coloured entity differs from it
    let team: Calibration['team'] = null;
    if (color) {
      const cid = (e: number) => readWord(e, color!.slot, color!.word);
      const neutral = ents.filter((e) => NEUTRAL_COLOR_IDS.has(cid(e) ?? -1));
      const teamed = ents.filter((e) => TEAM_COLOR_IDS.has(cid(e) ?? -1));
      const teamFits = (slotOff: number, word: number) => {
        if (neutral.length < 3 || teamed.length < 1) return false;
        const nv = new Set(neutral.map((e) => readWord(e, slotOff, word)));
        if (nv.size !== 1) return false;
        const n0 = [...nv][0];
        if (n0 === undefined) return false;
        // same team colour -> same value, and differs from the neutral value
        const byColor = new Map<number, Set<number | undefined>>();
        for (const e of teamed) {
          const c = cid(e)!;
          if (!byColor.has(c)) byColor.set(c, new Set());
          byColor.get(c)!.add(readWord(e, slotOff, word));
        }
        return [...byColor.values()].every((s) => s.size === 1 && !s.has(n0) && !s.has(undefined));
      };
      if (teamFits(DEFAULT_TEAM.slot, DEFAULT_TEAM.word)) team = DEFAULT_TEAM;
    }

    // tank markers: component pointers present on the own tank (circle nearest the camera) but on no polygon
    let tankMarkers: number[] = [];
    const ownCandidates = ents.filter((e) => shape(e).sides === 1).map((e) => {
      const m = v.rd(e + mo.k);
      return { e, d: Math.hypot(layout.decodeAt(m + x) - camX, layout.decodeAt(m + y) - camY) };
    }).filter((c) => c.d < OWN_TANK_RANGE).sort((a, b) => a.d - b.d);
    const polys = ents.filter((e) => shape(e).sides >= 3);
    if (ownCandidates.length > 0 && polys.length >= 3) {
      const own = ownCandidates[0].e;
      for (let k = 0; k < L.slotStride; k += 4) {
        if (k === wo.k || k === mo.k || k === so.k) continue;
        if (v.okPtr(v.rd(own + k)) && polys.every((e) => !v.okPtr(v.rd(e + k)))) tankMarkers.push(k);
      }
    }
    if (tankMarkers.length > 4) tankMarkers = []; // implausible; fall back to size

    return { worldId, worldOffset: wo.k, motionOffset: mo.k, shapeOffset: so.k, x, y, color, team, tankMarkers };
  }

  // ---------- per frame ----------

  #frame(): void {
    const L = layout.entityLayout;
    if (L === null) {
      this.#entities = [];
      this.#setError(layout.entityLayoutError?.message ?? 'entity layout not resolved yet');
      return;
    }
    if (this.#cal === null) {
      const c = this.#calibrate(L);
      if (typeof c === 'string') {
        this.#entities = [];
        this.#setError(c);
        return;
      }
      this.#cal = c;
      console.log('diepAPI memoryEntityManager: calibrated', c);
    }
    const v = this.#views();
    const addr = layout.addresses;
    if (!v || !addr) return;
    const cal = this.#cal;

    // the arena world can be replaced (respawn / reload); follow it
    const worlds = this.#arenaWorlds(L, v, addr.cameraBase);
    const world = worlds.find((x) => x.id === cal.worldId) ?? worlds[worlds.length - 1];
    if (!world) {
      this.#entities = [];
      this.#setError('no arena world (not in a game?)');
      return;
    }
    if (world.id !== cal.worldId) {
      cal.worldId = world.id;
      this.#bySlot.clear();
    }

    const rows: Row[] = [];
    for (const { slot, e } of this.#slots(L, v, world.w)) {
      if (v.rd(e + cal.worldOffset) !== world.w) continue;
      const m = v.rd(e + cal.motionOffset);
      if (!v.okPtr(m) || v.rd(m) !== e) continue;
      const sp = v.rd(e + cal.shapeOffset);
      if (!v.okPtr(sp)) continue;
      const sides = v.rd(sp + L.shapeSides);
      const size = layout.decodeAt(sp + L.shapeSize);
      const x = layout.decodeAt(m + cal.x);
      const y = layout.decodeAt(m + cal.y);
      if (!Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) continue; // not placed yet
      const word = (o: { slot: number; word: number } | null) => {
        if (!o) return undefined;
        const p = v.rd(e + o.slot);
        return v.okPtr(p) ? v.rd(p + o.word) : undefined;
      };
      const radius = radiusOf(sides, size);
      const isTank = sides === 1 && (cal.tankMarkers.length > 0
        ? cal.tankMarkers.some((k) => v.okPtr(v.rd(e + k)))
        : radius >= 40);
      rows.push({
        key: `${world.id}:${slot}`, e, x, y, sides, size, radius,
        colorId: word(cal.color), team: word(cal.team), isTank,
      });
    }

    const next = new Map<string, Entity>();
    const list: Entity[] = [];
    for (const r of rows) {
      const type = classify(r);
      if (type === null) continue;
      const pos = new Vector(r.x, r.y);
      let ent = this.#bySlot.get(r.key);
      const reused = ent !== undefined && ent.extras.sides === r.sides && ent.extras.colorId === r.colorId &&
        Vector.distance(ent.position, pos) < 500;
      if (!reused) {
        ent = new Entity(type, this.#findParent(r, type), {
          id: r.key, timestamp: performance.now(), slot: r.key,
        });
      }
      ent = ent!;
      ent.type = type;
      Object.assign(ent.extras, {
        radius: r.radius, sides: r.sides, colorId: r.colorId, team: r.team,
        color: r.colorId !== undefined ? COLOR_HEX[r.colorId] : undefined,
      });
      ent.updatePos(pos);
      next.set(r.key, ent);
      list.push(ent);
    }
    // self-check: real arenas always have drifting shapes; if nothing moves for ~2 s, recalibrate
    let moved = false;
    for (const ent of list) {
      if (ent.velocity.x !== 0 || ent.velocity.y !== 0) {
        moved = true;
        break;
      }
    }
    this.#frozenFrames = moved || list.length < 10 ? 0 : this.#frozenFrames + 1;
    if (this.#frozenFrames > 120) {
      console.warn('diepAPI memoryEntityManager: no entity has moved for ~2 s; recalibrating');
      this.#frozenFrames = 0;
      this.recalibrate();
    }

    this.#bySlot = next;
    this.#entities = list;
    this.#lastError = null;
  }

  /** Bullets get the nearest same-team tank (within 300 units) as parent when first seen. */
  #findParent(r: Row, type: EntityType): Entity | undefined {
    if (type !== EntityType.Bullet) return undefined;
    let best: Entity | undefined;
    let bestDist = 300;
    for (const e of this.#entities) {
      if (e.type !== EntityType.Player) continue;
      if (r.team !== undefined && e.extras.team !== undefined && e.extras.team !== r.team) continue;
      const d = Math.hypot(e.position.x - r.x, e.position.y - r.y);
      if (d < bestDist) {
        bestDist = d;
        best = e;
      }
    }
    return best;
  }
}

export const memoryEntityManager = new MemoryEntityManager();

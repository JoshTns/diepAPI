import { game } from './game';
import { CanvasKit, Vector } from '../core';
import { Entity, EntityColor, EntityType, TeamColors } from '../types/entity';
import { layout } from '../wasm';

const random_id = () => Math.random().toString(36).slice(2, 7);

type RenderingContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Fill colour of gun barrels; a body circle right after one belongs to a tank. */
const BARREL_COLOR = '#999999';
/** Outline radius (arena units) above which a barrel-less circle is still treated as a tank. */
const BARRELLESS_TANK_RADIUS = 50;
/** Max distance (arena units) between an entity's predicted and observed position across frames. */
const MATCH_TOLERANCE = 42;

type Kind = 'polygon' | 'circle';

interface Sighting {
  kind: Kind;
  type: EntityType;
  position: Vector;
  radius: number;
  color: string;
}

interface FrameView {
  cx: number;
  cy: number;
  camX: number;
  camY: number;
  scale: number;
}

const near = (value: number, target: number, tolerance = 3) => Math.abs(value - target) <= tolerance;

function classifyPolygon(color: string, radius: number): EntityType {
  switch (color) {
    case EntityColor.Square:
      return EntityType.Square;
    case EntityColor.Triangle:
      return EntityType.Triangle;
    case EntityColor.Pentagon: // same colour as AlphaPentagon
      return radius > 150 ? EntityType.AlphaPentagon : EntityType.Pentagon;
    case EntityColor.Hexagon:
      return EntityType.Hexagon;
    case EntityColor.Crasher:
      return EntityType.Crasher;
    case EntityColor.NecromancerDrone:
      return EntityType.Drone;
  }
  // team-coloured polygons: drones (and traps, which look the same to us)
  if ((TeamColors as string[]).includes(color)) return EntityType.Drone;
  return EntityType.UNKNOWN;
}

/**
 * Entity Manager is used to access the information about the entities that are currently drawn on
 * the screen. To access the entities the EntityManager exposes the EntityManager.entities field.
 *
 * How the current renderer draws (from captured frames, 2026-11-10):
 * - shapes/drones: beginPath, moveTo/lineTo outline in canvas px (vertex count varies), closePath,
 *   moveTo(center), fill(colour), stroke. The moveTo after closePath is the shape's centre.
 * - tanks and bullets: arc(0,0,1) placed by the transform: outline arc+fill, body arc+fill, one
 *   unfilled arc. Tanks have their barrels (fill #999999) drawn right before the body.
 * Only the main game canvas (#canvas) is inspected; UI and minimap live on other canvases.
 */
class EntityManager {
  #entities: Entity[] = [];
  #entitiesLastFrame: Entity[] = this.#entities;
  #claimed = new Set<Entity>();

  // per-frame cached view (camera/scale are read once, after the game has updated them)
  #view: FrameView | null = null;

  // path recorder state
  #pts: [number, number][] = [];
  #closed = false;
  #center: [number, number] | null = null;
  #arc: [number, number, number] | null = null;

  // circle sequence state: outline (r1) then body (r2 < r1) at the same centre
  #outline: { x: number; y: number; r: number } | null = null;
  #barrelSeen = false;

  constructor() {
    game.on('frame_end', () => {
      this.#entitiesLastFrame = this.#entities;
      this.#entities = [];
      this.#claimed = new Set();
      this.#view = null;
      this.#outline = null;
      this.#barrelSeen = false;
    });
    this.#installHooks();
  }

  get entities(): Entity[] {
    return this.#entities;
  }

  /**
   * @returns The own player entity: the tank nearest to the camera. The camera trails the tank
   * while moving (about 50 units at full speed), so this allows up to 150 units of offset.
   */
  getPlayer(): Entity | undefined {
    const addr = layout.addresses;
    if (addr === null) return undefined;
    const cam = new Vector(layout.decodeAt(addr.cameraX), layout.decodeAt(addr.cameraY));
    let best: Entity | undefined;
    let bestDist = 150;
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

  #isGameCanvas(ctx: RenderingContext): boolean {
    return (ctx.canvas as HTMLCanvasElement).id === 'canvas';
  }

  #frameView(ctx: RenderingContext): FrameView | null {
    if (this.#view) return this.#view;
    const addr = layout.addresses;
    if (addr === null) return null;
    const scale = layout.decodeAt(addr.scale);
    if (!(scale > 0)) return null;
    this.#view = {
      cx: ctx.canvas.width / 2,
      cy: ctx.canvas.height / 2,
      camX: layout.decodeAt(addr.cameraX),
      camY: layout.decodeAt(addr.cameraY),
      scale,
    };
    return this.#view;
  }

  #toArena(view: FrameView, x: number, y: number): Vector {
    return new Vector((x - view.cx) / view.scale + view.camX, (y - view.cy) / view.scale + view.camY);
  }

  #installHooks(): void {
    const transformPoint = (ctx: RenderingContext, x: number, y: number): [number, number] => {
      const t = ctx.getTransform();
      return [t.a * x + t.c * y + t.e, t.b * x + t.d * y + t.f];
    };

    CanvasKit.hookCtx('beginPath', (_t, ctx) => {
      if (!this.#isGameCanvas(ctx)) return;
      this.#pts = [];
      this.#closed = false;
      this.#center = null;
      this.#arc = null;
    });

    CanvasKit.hookCtx('moveTo', (_t, ctx, args) => {
      if (!this.#isGameCanvas(ctx)) return;
      const p = transformPoint(ctx, args[0], args[1]);
      if (this.#closed) this.#center = p;
      else this.#pts.push(p);
    });

    CanvasKit.hookCtx('lineTo', (_t, ctx, args) => {
      if (!this.#isGameCanvas(ctx)) return;
      if (!this.#closed) this.#pts.push(transformPoint(ctx, args[0], args[1]));
    });

    CanvasKit.hookCtx('closePath', (_t, ctx) => {
      if (!this.#isGameCanvas(ctx)) return;
      this.#closed = true;
    });

    CanvasKit.hookCtx('arc', (_t, ctx, args) => {
      if (!this.#isGameCanvas(ctx)) return;
      const t = ctx.getTransform();
      const [x0, y0, r] = args;
      this.#arc = [t.a * x0 + t.c * y0 + t.e, t.b * x0 + t.d * y0 + t.f, r * Math.hypot(t.a, t.b)];
    });

    CanvasKit.hookCtx('fill', (_t, ctx) => {
      if (!this.#isGameCanvas(ctx)) return;
      const color = String(ctx.fillStyle);

      if (color === BARREL_COLOR) {
        this.#barrelSeen = true;
        this.#outline = null;
        return;
      }

      if (this.#closed && this.#center !== null && this.#pts.length >= 3) {
        this.#onPolygon(ctx, color);
        return;
      }

      if (this.#arc !== null) {
        this.#onCircleFill(ctx, color);
      }
    });
  }

  #onPolygon(ctx: RenderingContext, color: string): void {
    const view = this.#frameView(ctx);
    if (view === null || this.#center === null) return;
    const [cx, cy] = this.#center;
    let rPx = 0;
    for (const [x, y] of this.#pts) rPx = Math.max(rPx, Math.hypot(x - cx, y - cy));
    const radius = Math.round(rPx / view.scale);

    this.#barrelSeen = false;
    this.#outline = null;
    this.#add({
      kind: 'polygon',
      type: classifyPolygon(color, radius),
      position: this.#toArena(view, cx, cy),
      radius,
      color,
    });
  }

  #onCircleFill(ctx: RenderingContext, color: string): void {
    if (this.#arc === null) return;
    const [x, y, r] = this.#arc;
    const outline = this.#outline;

    // second fill at the same centre with a smaller radius = body; emit the entity
    if (outline !== null && near(outline.x, x, 0.5) && near(outline.y, y, 0.5) && r < outline.r) {
      const view = this.#frameView(ctx);
      this.#outline = null;
      if (view === null) return;
      const radius = Math.round(outline.r / view.scale);
      const isTank = this.#barrelSeen || radius >= BARRELLESS_TANK_RADIUS;
      this.#barrelSeen = false;
      this.#add({
        kind: 'circle',
        type: isTank ? EntityType.Player : EntityType.Bullet,
        position: this.#toArena(view, x, y),
        radius,
        color,
      });
      return;
    }

    // otherwise this is (possibly) an outline; remember it
    this.#outline = { x, y, r };
  }

  /** Adds the sighting to `#entities`, continuing a matching entity from the last frame if any. */
  #add(s: Sighting): void {
    let entity = this.#findEntity(s);

    if (entity) {
      this.#claimed.add(entity);
      if (entity.type === EntityType.UNKNOWN && s.type !== EntityType.UNKNOWN) entity.type = s.type;
    } else {
      entity = new Entity(s.type, this.#findParent(s), {
        id: random_id(),
        timestamp: performance.now(),
        color: s.color,
        radius: s.radius,
      });
    }
    entity.extras.radius = s.radius;
    entity.extras.color = s.color;
    entity.updatePos(s.position);
    this.#entities.push(entity);
  }

  /** Bullets get the nearest tank (within 300 units) as their parent when first seen. */
  #findParent(s: Sighting): Entity | undefined {
    if (s.type !== EntityType.Bullet) return undefined;
    let best: Entity | undefined;
    let bestDist = 300;
    for (const e of this.#entitiesLastFrame) {
      if (e.type !== EntityType.Player) continue;
      const d = Vector.distance(e.position, s.position);
      if (d < bestDist) {
        bestDist = d;
        best = e;
      }
    }
    return best;
  }

  /**
   * Nearest unclaimed entity from last frame of a compatible kind/type and similar size, compared
   * at its predicted position (so fast bullets stay matched).
   */
  #findEntity(s: Sighting): Entity | undefined {
    let result: Entity | undefined;
    let shortest = MATCH_TOLERANCE;
    const wantKind = s.kind === 'circle';

    for (const e of this.#entitiesLastFrame) {
      if (this.#claimed.has(e)) continue;
      const eIsCircle = e.type === EntityType.Player || e.type === EntityType.Bullet;
      if (eIsCircle !== wantKind && e.type !== EntityType.UNKNOWN && s.type !== EntityType.UNKNOWN) continue;
      if (e.type !== s.type && e.type !== EntityType.UNKNOWN && s.type !== EntityType.UNKNOWN) continue;
      const r = e.extras.radius ?? s.radius;
      if (Math.abs(r - s.radius) > Math.max(6, 0.25 * s.radius)) continue;

      const d = Vector.distance(e.predictPos(0), s.position);
      if (d < shortest) {
        shortest = d;
        result = e;
      }
    }
    return result;
  }
}

export const entityManager = new EntityManager();

import { EventEmitter } from '../core';
import { resolveEntityLayout, type EntityLayout } from './entity_signatures';
import { makeDecoder, resolveLayout, type ResolvedLayout } from './signatures';
import { wasmInstance } from './wasm-instance';

export type LayoutEvents = 'resolved' | 'failed';

/**
 * Memory layout of the running game, resolved from the wasm bytes when the game loads.
 *
 * Events:
 * - resolved: the signature scan succeeded and addresses are available
 * - failed: the scan failed (the game's code shape changed); see `error`
 */
class Layout extends EventEmitter<LayoutEvents> {
  #resolved: ResolvedLayout | null = null;
  #decodeAt: ((addr: number) => number) | null = null;
  #error: Error | null = null;
  #entityLayout: EntityLayout | null = null;
  #entityError: Error | null = null;

  constructor() {
    super();
    wasmInstance.on('instantiated', () => {
      try {
        const bytes = wasmInstance.bytes;
        const memory = wasmInstance.memory;
        if (bytes === null || memory === null) throw new Error('diepAPI: wasm bytes or memory missing');

        const resolved = resolveLayout(bytes);
        this.#decodeAt = makeDecoder(resolved.decoderBytes, memory);
        this.#resolved = resolved;
        console.log('diepAPI: memory layout resolved', {
          cameraBase: resolved.cameraBase,
          offsets: resolved.offsets,
          canvas: [resolved.canvasWidth, resolved.canvasHeight],
        });
        super.emit('resolved');
      } catch (e) {
        this.#error = e instanceof Error ? e : new Error(String(e));
        console.warn('diepAPI: memory layout could not be resolved:', this.#error.message);
        super.emit('failed');
      }
    });
  }

  get ready(): boolean {
    return this.#resolved !== null;
  }

  get error(): Error | null {
    return this.#error;
  }

  /** Resolved addresses, or null before the game loaded or if resolving failed. */
  get addresses(): Omit<ResolvedLayout, 'decoderBytes'> | null {
    if (this.#resolved === null) return null;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { decoderBytes, ...rest } = this.#resolved;
    return rest;
  }

  /**
   * Entity storage layout (registry, pool, component field offsets), resolved lazily from the wasm
   * bytes on first access (takes a few hundred ms once). null if it could not be resolved; see
   * `entityLayoutError`.
   */
  get entityLayout(): EntityLayout | null {
    if (this.#entityLayout === null && this.#entityError === null && this.#resolved !== null) {
      const bytes = wasmInstance.bytes;
      try {
        if (bytes === null) throw new Error('diepAPI: wasm bytes missing');
        this.#entityLayout = resolveEntityLayout(bytes);
        console.log('diepAPI: entity layout resolved', this.#entityLayout);
      } catch (e) {
        this.#entityError = e instanceof Error ? e : new Error(String(e));
        console.warn('diepAPI: entity layout could not be resolved:', this.#entityError.message);
      }
    }
    return this.#entityLayout;
  }

  get entityLayoutError(): Error | null {
    return this.#entityError;
  }

  /** Decode the obfuscated f32 stored at `addr` using the game's own decode routine. */
  decodeAt(addr: number): number {
    return this.#decodeAt === null ? NaN : this.#decodeAt(addr);
  }
}

export const layout = new Layout();

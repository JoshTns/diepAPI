import { EventEmitter } from '../core';
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

  /** Decode the obfuscated f32 stored at `addr` using the game's own decode routine. */
  decodeAt(addr: number): number {
    return this.#decodeAt === null ? NaN : this.#decodeAt(addr);
  }
}

export const layout = new Layout();

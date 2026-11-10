import { Vector } from '../core/vector';
import { layout } from '../wasm';

class Camera {
  /**
   * Camera position in arena units, read from the game's camera object.
   * Returns (0, 0) until the memory layout has been resolved.
   */
  get position(): Vector {
    const addr = layout.addresses;
    if (addr === null) {
      return new Vector(0, 0);
    }

    const cameraX = Math.round(layout.decodeAt(addr.cameraX));
    const cameraY = Math.round(layout.decodeAt(addr.cameraY));

    return new Vector(cameraX, cameraY);
  }
}

export const camera = new Camera();

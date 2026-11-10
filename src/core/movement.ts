import { Vector } from './vector';

export class Movement {
  #position = new Vector(0, 0);
  #velocity = new Vector(0, 0);

  /*
   * Used for the velocity calculation: the last N (displacement, duration) samples. Velocity is total
   * displacement / total time over the window, so uneven frame times don't skew it.
   */
  readonly #velocitySamplesSize = 10;
  #velocitySamples: { d: Vector; dt: number }[] = [];
  #velocitySamplesIndex = 0;
  #velocityLastNow = performance.now();
  /** false until the first position arrives; the first update must not produce a velocity sample */
  #hasPosition = false;

  get position(): Vector {
    return this.#position;
  }

  /**
   * Velocity in [diep_]units / second
   */
  get velocity(): Vector {
    return this.#velocity;
  }

  /**
   * Predict where this object will be after `time`
   * @param time The time in ms.
   */
  predictPos(time: number): Vector {
    const duration = (time + performance.now() - this.#velocityLastNow) / 1000;
    return Vector.add(this.#position, Vector.scale(duration, this.#velocity));
  }

  protected updatePos(newPos: Vector): void {
    if (!this.#hasPosition) {
      // first sighting: there is no previous position to compute a velocity from
      this.#hasPosition = true;
      this.#velocityLastNow = performance.now();
      this.#position = newPos;
      return;
    }
    this.#updateVelocity(newPos);
    this.#position = newPos;
  }

  #updateVelocity(newPos: Vector): void {
    const now = performance.now();
    const dt = (now - this.#velocityLastNow) / 1000;
    if (dt <= 0) return;
    this.#velocityLastNow = now;

    this.#velocitySamples[this.#velocitySamplesIndex++] = { d: Vector.subtract(newPos, this.#position), dt };
    this.#velocitySamplesIndex %= this.#velocitySamplesSize;

    let dx = 0;
    let dy = 0;
    let total = 0;
    for (const s of this.#velocitySamples) {
      dx += s.d.x;
      dy += s.d.y;
      total += s.dt;
    }
    this.#velocity = new Vector(dx / total, dy / total);
  }
}

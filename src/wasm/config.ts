/*
 * Camera, scale and canvas-size addresses are no longer hard-coded: they are resolved from the
 * game's wasm bytes at load time (see ./signatures.ts and ./layout.ts).
 *
 * For reference, the build with ETag W/"2c97e3dbbead03d69bbb5b686f86bd3c" (2026-11-10) resolves to
 * camera object 483240, camera X +10072, scale +10080, camera Y +10104, canvas 554696 / 554700.
 */

/** Arena size has not been located for the current build; arena.size returns (0, 0) while these are 0. */
export const ARENA_WIDTH_ADDR = 0;
export const ARENA_HEIGHT_ADDR = 0;

import { CanvasKit, EventEmitter } from '../core';

export type GameEvents =
  | 'ready'
  | 'before_frame'
  | 'after_frame'
  | 'frame_start'
  | 'frame'
  | 'frame_end'
  | 'render_start'
  | 'state'
  | 's_home'
  | 's_game'
  | 's_stats'
  | 's_loading'
  | 's_captcha';

/**
 * Events:
 * - ready: Emitted when the game is ready
 * - before_frame: Emitted before the game frame starts
 * - after_frame: Emitted after the game frame ends
 * - frame_start: Emitted before `frame` and is mainly used internally to run setup code before the frame handlers
 * - frame: Emitted every frame after game logic is processed. Can be used for things that should be executed on every frame
 * - frame_end: Emitted after `frame` and is mainly used internally to update position variables
 * - render_start: Emitted once per rendered game frame, when the game clears its main canvas to start
 *   drawing. Unlike the frame events (which fire on every requestAnimationFrame call on the page, from
 *   any script), this follows the game's renderer exactly. Use it for anything sampled per game frame.
 * - state => (state): Emitted whenever the game changes its state: 'home', 'game', 'stats', 'loading', 'captcha
 * - s_home: Emitted when the game changes its state to home
 * - s_game: Emitted when the game changes its state to game
 * - s_stats: Emitted when the game changes its state to stats
 * - s_loading: Emitted when the game changes its state to loading
 * - s_captcha: Emitted when the game changes its state to captcha
 */
class Game extends EventEmitter<GameEvents> {
  #isReady = false;
  #shadowRoot: ShadowRoot | undefined | null;
  #renderFrame = 0;

  constructor() {
    super();

    // The game clears the whole main canvas exactly once at the start of every rendered frame.
    CanvasKit.hookCtx('clearRect', (_target, ctx, args) => {
      const canvas = ctx.canvas as HTMLCanvasElement;
      if (canvas.id !== 'canvas') return;
      if (args[0] > 0 || args[1] > 0 || args[2] < canvas.width || args[3] < canvas.height) return;
      this.#renderFrame++;
      super.emit('render_start');
    });

    CanvasKit.replaceRAF((target, thisArg, args) => {
      super.emit('before_frame');

      this.#onFrame();
      const result = Reflect.apply(target, thisArg, args);

      super.emit('after_frame');

      return result;
    });
  }

  #onFrame(): void {
    if (!this.#isReady && _window.input !== undefined) {
      this.#isReady = true;
      this.#onready();
    }

    super.emit('frame_start');
    super.emit('frame');
    super.emit('frame_end');
  }

  #onready(): void {
    setTimeout(() => {
      super.emit('ready');
    }, 100);

    // TODO: Causes the game not to load. Find a fix.
    // this.#shadowRoot = document.querySelector('d-base')?.shadowRoot;
    // if (this.#shadowRoot == null) {
    //   throw new Error('diepAPI: Shadow root does not exist.');
    // }

    // new MutationObserver((mutationList, observer) => {
    //   mutationList.forEach((mutation) => {
    //     if (mutation.addedNodes.length === 0) {
    //       return;
    //     }

    //     super.emit('state', this.state);
    //     super.emit(`s_${this.state}`);
    //   });
    // }).observe(this.#shadowRoot, { childList: true });
  }

  /** Number of rendered game frames seen so far (increments on `render_start`). */
  get renderFrame(): number {
    return this.#renderFrame;
  }

  get state(): string | undefined {
    return this.#shadowRoot?.querySelector('.screen')?.tagName.slice(2).toLowerCase();
  }

  get inHome(): boolean {
    return this.state === 'home';
  }

  get inGame(): boolean {
    return this.state === 'game';
  }

  get inStats(): boolean {
    return this.state === 'stats';
  }

  get inLoading(): boolean {
    return this.state === 'loading';
  }

  get inCaptcha(): boolean {
    return this.state === 'captcha';
  }
}

export const game = new Game();

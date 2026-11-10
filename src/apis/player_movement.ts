import { Movement } from '../core/movement';
import { camera } from './camera';
import { game } from './game';

class PlayerMovement extends Movement {
  /**
   * Player position and velocity from the game's camera. The camera trails the tank by up to
   * ~50 units while moving; entityManager.getPlayer() gives the tank's drawn position.
   */
  constructor() {
    super();

    // once per rendered game frame (frame_end fires on every requestAnimationFrame call on the page)
    game.on('render_start', () => {
      super.updatePos(camera.position);
    });
  }
}

export const playerMovement = new PlayerMovement();

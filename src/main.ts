/**
 * PointCloud Inspector — application entry.
 *
 * Boots the stylesheet layers (design tokens → base → components → app shell)
 * and starts the main controller.
 */

import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/app.css';

import { App } from './app';

function boot(): void {
  let app: App;
  try {
    app = new App();
    app.start();
  } catch (err) {
    console.error('[pointcloud-inspector] boot failed', err);
    const veil = document.getElementById('loadingVeil');
    const label = document.getElementById('loadingLabel');
    if (label) label.textContent = '初始化失败，请查看控制台输出。';
    if (veil) veil.hidden = false;
    return;
  }

  // Expose for quick console debugging; harmless in production.
  (window as unknown as { __pci?: App }).__pci = app;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

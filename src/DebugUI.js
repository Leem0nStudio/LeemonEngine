/**
 * DebugUI – Floating debug panel for terrain inspection.
 *
 * Toggle with Ctrl+D (or call debugUI.toggle()).
 *
 * Features:
 *   • Seed display + editor
 *   • Visual overlays: grid, height gradient, collision circles
 *   • FPS counter + rendered object count + loaded chunks
 *   • Copy seed to clipboard
 *
 * Usage:
 *   const debug = new DebugUI({ scene, seed, chunkManager });
 *   debug.update();      // call each frame
 *   debug.dispose();     // call on cleanup
 */
import * as THREE from 'three';
import { CHUNK_SIZE } from './shared/TerrainChunk.js';

const HEIGHT_COLORS = [
  { t: 0.0, color: new THREE.Color(0x1a5fb4) },
  { t: 0.25, color: new THREE.Color(0x26a269) },
  { t: 0.5, color: new THREE.Color(0xf5c211) },
  { t: 0.75, color: new THREE.Color(0xe66100) },
  { t: 1.0, color: new THREE.Color(0xc01c28) },
];

function heightToColor(h, minH, maxH) {
  const t = Math.max(0, Math.min(1, (h - minH) / (maxH - minH)));
  for (let i = 0; i < HEIGHT_COLORS.length - 1; i++) {
    if (t >= HEIGHT_COLORS[i].t && t <= HEIGHT_COLORS[i + 1].t) {
      const local = (t - HEIGHT_COLORS[i].t) / (HEIGHT_COLORS[i + 1].t - HEIGHT_COLORS[i].t);
      return new THREE.Color().lerpColors(HEIGHT_COLORS[i].color, HEIGHT_COLORS[i + 1].color, local);
    }
  }
  return HEIGHT_COLORS[HEIGHT_COLORS.length - 1].color;
}

export class DebugUI {
  /**
   * @param {object} opts
   * @param {THREE.Scene} opts.scene
   * @param {number} opts.seed
   * @param {import('./ChunkManager.js').ChunkManager} opts.chunkManager
   */
  constructor({ scene, seed, chunkManager }) {
    this.scene = scene;
    this.seed = seed;
    this.chunkManager = chunkManager;

    this.visible = false;
    this._overlayObjects = [];
    this._lastFrameTime = performance.now();
    this._fps = 0;
    this._frameCount = 0;

    this.showGrid = false;
    this.showHeights = false;
    this.showCollisions = false;

    this._createPanel();
    this._bindKeyboard();
  }

  toggle() {
    this.visible = !this.visible;
    this._panel.style.display = this.visible ? 'block' : 'none';
  }

  update() {
    if (!this.visible) return;

    this._frameCount++;
    const now = performance.now();
    if (now - this._lastFrameTime >= 1000) {
      this._fps = this._frameCount;
      this._frameCount = 0;
      this._lastFrameTime = now;
      this._fpsEl.textContent = this._fps;
    }

    let meshes = 0;
    let sprites = 0;
    this.scene.traverse((child) => {
      if (child.isMesh) meshes++;
      if (child.isSprite) sprites++;
    });
    this._objectsEl.textContent = `${meshes}m ${sprites}s`;

    // Show loaded chunks
    if (this.chunkManager) {
      this._chunksEl.textContent = this.chunkManager.loadedChunkCount;
    }
  }

  dispose() {
    this._clearOverlays();
    this._panel.remove();
    document.removeEventListener('keydown', this._keyHandler);
  }

  // ── Panel ────────────────────────────────────────────────────────────────

  _createPanel() {
    const panel = document.createElement('div');
    panel.id = 'debug-panel';
    panel.style.cssText = `
      position: fixed; top: 10px; right: 10px; z-index: 9999;
      background: rgba(15, 23, 42, 0.92); border: 1px solid #334155;
      border-radius: 12px; padding: 16px; width: 260px;
      font-family: 'Outfit', monospace; font-size: 12px; color: #e2e8f0;
      backdrop-filter: blur(8px); display: none; user-select: none;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    `;
    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <span style="font-weight:700;color:#38bdf8;font-size:14px;">Debug Panel</span>
        <span style="font-size:10px;color:#64748b;">Ctrl+D</span>
      </div>

      <div style="margin-bottom:10px;">
        <label style="color:#94a3b8;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;">Seed</label>
        <div style="display:flex;gap:6px;margin-top:4px;">
          <input id="debug-seed" type="number" style="flex:1;background:#0f172a;border:1px solid #334155;color:#e2e8f0;padding:4px 8px;border-radius:6px;font-family:monospace;" />
          <button id="debug-seed-copy" title="Copy" style="background:#334155;color:#94a3b8;border:none;padding:4px 8px;border-radius:6px;cursor:pointer;">Copy</button>
        </div>
      </div>

      <div style="margin-bottom:10px;">
        <label style="color:#94a3b8;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;">Overlays</label>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:4px;">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;color:#cbd5e1;">
            <input id="debug-grid" type="checkbox" /> Grid
          </label>
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;color:#cbd5e1;">
            <input id="debug-heights" type="checkbox" /> Heights
          </label>
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;color:#cbd5e1;">
            <input id="debug-collisions" type="checkbox" /> Collisions
          </label>
        </div>
      </div>

      <div style="border-top:1px solid #1e293b;padding-top:8px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;">
        <div>
          <span style="color:#64748b;font-size:10px;">FPS</span>
          <span id="debug-fps" style="display:block;color:#34d399;font-weight:700;font-size:18px;font-family:monospace;">-</span>
        </div>
        <div>
          <span style="color:#64748b;font-size:10px;">Objects</span>
          <span id="debug-objects" style="display:block;color:#fbbf24;font-weight:700;font-size:14px;font-family:monospace;">-</span>
        </div>
        <div>
          <span style="color:#64748b;font-size:10px;">Chunks</span>
          <span id="debug-chunks" style="display:block;color:#38bdf8;font-weight:700;font-size:14px;font-family:monospace;">0</span>
        </div>
      </div>

      <div style="border-top:1px solid #1e293b;margin-top:8px;padding-top:8px;color:#64748b;font-size:10px;">
        <div style="margin-bottom:2px;">Heights: Low -> High</div>
        <div>Collisions: Red rings</div>
      </div>
    `;
    document.body.appendChild(panel);
    this._panel = panel;

    this._seedInput = panel.querySelector('#debug-seed');
    this._seedCopyBtn = panel.querySelector('#debug-seed-copy');
    this._gridCb = panel.querySelector('#debug-grid');
    this._heightsCb = panel.querySelector('#debug-heights');
    this._collisionsCb = panel.querySelector('#debug-collisions');
    this._fpsEl = panel.querySelector('#debug-fps');
    this._objectsEl = panel.querySelector('#debug-objects');
    this._chunksEl = panel.querySelector('#debug-chunks');

    this._seedInput.value = this.seed || 42;

    this._seedCopyBtn.addEventListener('click', () => {
      navigator.clipboard?.writeText(this._seedInput.value);
      this._seedCopyBtn.textContent = 'Copied';
      setTimeout(() => { this._seedCopyBtn.textContent = 'Copy'; }, 1000);
    });

    this._gridCb.addEventListener('change', () => { this.showGrid = this._gridCb.checked; this._applyOverlays(); });
    this._heightsCb.addEventListener('change', () => { this.showHeights = this._heightsCb.checked; this._applyOverlays(); });
    this._collisionsCb.addEventListener('change', () => { this.showCollisions = this._collisionsCb.checked; this._applyOverlays(); });
  }

  _bindKeyboard() {
    this._keyHandler = (e) => {
      if (e.ctrlKey && e.key === 'd') {
        e.preventDefault();
        this.toggle();
      }
    };
    document.addEventListener('keydown', this._keyHandler);
  }

  // ── Overlays ──────────────────────────────────────────────────────────────

  _applyOverlays() {
    this._clearOverlays();
    if (this.showGrid) this._applyGrid();
    if (this.showHeights) this._applyHeights();
    if (this.showCollisions) this._applyCollisions();
  }

  _clearOverlays() {
    for (const obj of this._overlayObjects) {
      this.scene.remove(obj);
      obj.traverse((child) => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
          if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
          else child.material.dispose();
        }
      });
    }
    this._overlayObjects = [];
  }

  _applyGrid() {
    if (!this.chunkManager) return;

    const group = new THREE.Group();
    const loadedChunks = Array.from(this.chunkManager.chunks.keys());

    for (const key of loadedChunks) {
      const [cx, cz] = key.split(',').map(Number);
      const gridHelper = new THREE.GridHelper(CHUNK_SIZE, CHUNK_SIZE, 0x60a5fa, 0x1e40af);
      gridHelper.position.set(cx * CHUNK_SIZE + CHUNK_SIZE / 2, 0.05, cz * CHUNK_SIZE + CHUNK_SIZE / 2);
      gridHelper.material.opacity = 0.25;
      gridHelper.material.transparent = true;
      group.add(gridHelper);
    }

    this.scene.add(group);
    this._overlayObjects.push(group);
  }

  _applyHeights() {
    if (!this.chunkManager) return;

    const group = new THREE.Group();
    const step = 4;

    for (const [key, chunk] of this.chunkManager.chunks) {
      if (!chunk?.data) continue;
      const { heightmap, worldOffsetX, worldOffsetZ } = chunk.data;

      let minH = Infinity, maxH = -Infinity;
      for (let z = 0; z < CHUNK_SIZE; z++) {
        for (let x = 0; x < CHUNK_SIZE; x++) {
          const h = heightmap[z][x];
          if (h < minH) minH = h;
          if (h > maxH) maxH = h;
        }
      }

      for (let z = 0; z < CHUNK_SIZE; z += step) {
        for (let x = 0; x < CHUNK_SIZE; x += step) {
          const h = heightmap[z][x];
          const color = heightToColor(h, minH, maxH);
          const geo = new THREE.PlaneGeometry(step, step);
          const mat = new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0.45,
            side: THREE.DoubleSide,
            depthWrite: false,
          });
          const quad = new THREE.Mesh(geo, mat);
          quad.rotation.x = -Math.PI / 2;
          quad.position.set(worldOffsetX + x + step / 2, h + 0.03, worldOffsetZ + z + step / 2);
          group.add(quad);
        }
      }
    }

    this.scene.add(group);
    this._overlayObjects.push(group);
  }

  _applyCollisions() {
    if (!this.chunkManager) return;

    const group = new THREE.Group();

    for (const [, chunk] of this.chunkManager.chunks) {
      if (!chunk?.data) continue;
      const { collisionCircles, heightmap, worldOffsetX, worldOffsetZ } = chunk.data;

      for (const c of collisionCircles) {
        const localX = c.x - worldOffsetX;
        const localZ = c.z - worldOffsetZ;
        const h = heightmap[Math.floor(localZ)]?.[Math.floor(localX)] ?? 0;

        const ringGeo = new THREE.RingGeometry(c.radius * 0.8, c.radius, 16);
        const ringMat = new THREE.MeshBasicMaterial({
          color: 0xef4444,
          transparent: true,
          opacity: 0.5,
          side: THREE.DoubleSide,
          depthWrite: false,
        });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(c.x, h + 0.04, c.z);
        group.add(ring);
      }
    }

    this.scene.add(group);
    this._overlayObjects.push(group);
  }
}

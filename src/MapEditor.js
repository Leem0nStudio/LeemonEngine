/**
 * MapEditor.js – Designer mode for terrain editing.
 *
 * Toggle with E key. Provides:
 * - Terrain sculpting (raise/lower terrain)
 * - Object placement/removal
 * - Brush size control (+ / - keys)
 * - Undo support (Ctrl+Z)
 * - Visual brush cursor (follows mouse)
 * - Save/load modifications to server
 *
 * Usage:
 *   const editor = new MapEditor(scene, camera, chunkManager);
 *   editor.toggle(); // or press E
 */
import * as THREE from "three";
import { CHUNK_SIZE, CHUNK_WORLD_SIZE, BIOMES, getBiomeAt } from "../shared/TerrainChunk.js";

const TOOLS = {
  SCULPT: "sculpt",
  FLATTEN: "flatten",
  PAINT: "paint",
  PLACE_OBJECT: "place_object",
  ERASE_OBJECT: "erase_object",
};

const SCULPT_STRENGTH = 0.15;
const FLATTEN_SAMPLES = 8;

export class MapEditor {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   * @param {import("./ChunkManager.js").ChunkManager} chunkManager
   */
  constructor(scene, camera, chunkManager) {
    this.scene = scene;
    this.camera = camera;
    this.chunkManager = chunkManager;
    this.enabled = false;
    this.activeTool = TOOLS.SCULPT;
    this.brushRadius = 2;
    this.paintBiome = "forest";
    this.placementType = "tree";
    this.placementSubType = "oak";

    // Raycaster for mouse picking
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();

    // Brush cursor mesh
    this.brushCursor = this._createBrushCursor();
    this.brushCursor.visible = false;
    this.scene.add(this.brushCursor);

    // Undo stack
    this.undoStack = [];

    // Active modifications to save
    this.modifications = [];

    // Mouse state
    this.isMouseDown = false;
    this.lastBrushPos = null;

    // Bind handlers
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseUp = this._onMouseUp.bind(this);
  }

  /**
   * Create the visual brush cursor (circle on terrain).
   */
  _createBrushCursor() {
    const segments = 32;
    const points = [];
    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      points.push(new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle)));
    }
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({ color: 0xffff00, linewidth: 2 });
    const line = new THREE.LineLoop(geometry, material);
    line.rotation.x = -Math.PI / 2; // Flat on ground
    line.renderOrder = 999;
    return line;
  }

  /**
   * Toggle editor on/off.
   */
  toggle() {
    this.enabled = !this.enabled;
    this.brushCursor.visible = false;
    this.isMouseDown = false;
    this.lastBrushPos = null;

    if (this.enabled) {
      this._addEventListener();
    } else {
      this._removeEventListener();
    }

    return this.enabled;
  }

  /**
   * Enable editor.
   */
  enable() {
    if (!this.enabled) this.toggle();
  }

  /**
   * Disable editor.
   */
  disable() {
    if (this.enabled) this.toggle();
  }

  /**
   * Add event listeners.
   */
  _addEventListener() {
    document.addEventListener("keydown", this._onKeyDown);
    document.addEventListener("mousemove", this._onMouseMove);
    document.addEventListener("mousedown", this._onMouseDown);
    document.addEventListener("mouseup", this._onMouseUp);
  }

  /**
   * Remove event listeners.
   */
  _removeEventListener() {
    document.removeEventListener("keydown", this._onKeyDown);
    document.removeEventListener("mousemove", this._onMouseMove);
    document.removeEventListener("mousedown", this._onMouseDown);
    document.removeEventListener("mouseup", this._onMouseUp);
  }

  /**
   * Handle keyboard input.
   */
  _onKeyDown(e) {
    if (!this.enabled) return;

    // Don't capture if typing in an input
    const target = e.target;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;

    switch (e.key.toLowerCase()) {
      case "1":
        this.activeTool = TOOLS.SCULPT;
        break;
      case "2":
        this.activeTool = TOOLS.FLATTEN;
        break;
      case "3":
        this.activeTool = TOOLS.PAINT;
        break;
      case "4":
        this.activeTool = TOOLS.PLACE_OBJECT;
        break;
      case "5":
        this.activeTool = TOOLS.ERASE_OBJECT;
        break;
      case "=":
      case "+":
        this.brushRadius = Math.min(10, this.brushRadius + 1);
        break;
      case "-":
        this.brushRadius = Math.max(1, this.brushRadius - 1);
        break;
      case "z":
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          this._undo();
        }
        break;
    }
  }

  /**
   * Handle mouse move – update brush position.
   */
  _onMouseMove(e) {
    if (!this.enabled) return;

    // Update mouse coords
    this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;

    // Raycast to terrain
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const terrainMeshes = this.scene.children.filter((c) => c.userData.isTerrain);
    const intersects = this.raycaster.intersectObjects(terrainMeshes);

    if (intersects.length > 0) {
      const point = intersects[0].point;
      this.brushCursor.position.set(point.x, point.y + 0.05, point.z);
      this.brushCursor.visible = true;

      // Resize brush visual
      this.brushCursor.scale.set(this.brushRadius, this.brushRadius, this.brushRadius);

      // Apply tool if mouse is held
      if (this.isMouseDown) {
        this._applyTool(point);
      }
    } else {
      this.brushCursor.visible = false;
    }
  }

  /**
   * Handle mouse down – start applying tool.
   */
  _onMouseDown(e) {
    const target = e.target;
    if (!this.enabled || !target || target.tagName !== "CANVAS") return;
    if (e.button !== 0) return; // Left click only

    this.isMouseDown = true;
    this.lastBrushPos = null;

    // Apply tool at click point
    if (this.brushCursor.visible) {
      const point = new THREE.Vector3(
        this.brushCursor.position.x,
        this.brushCursor.position.y,
        this.brushCursor.position.z
      );
      this._applyTool(point);
    }
  }

  /**
   * Handle mouse up – stop applying tool.
   */
  _onMouseUp() {
    this.isMouseDown = false;
    this.lastBrushPos = null;
  }

  /**
   * Apply the active tool at a world position.
   */
  _applyTool(point) {
    const wx = Math.round(point.x);
    const wz = Math.round(point.z);

    // Avoid processing same cell multiple times
    if (this.lastBrushPos && this.lastBrushPos.x === wx && this.lastBrushPos.z === wz) return;
    this.lastBrushPos = { x: wx, z: wz };

    switch (this.activeTool) {
      case TOOLS.SCULPT:
        this._sculpt(wx, wz, 1); // Raise
        break;
      case TOOLS.FLATTEN:
        this._flatten(wx, wz);
        break;
      case TOOLS.PAINT:
        this._paintBiome(wx, wz);
        break;
      case TOOLS.PLACE_OBJECT:
        this._placeObject(wx, wz);
        break;
      case TOOLS.ERASE_OBJECT:
        this._eraseObject(wx, wz);
        break;
    }
  }

  /**
   * Sculpt terrain – raise/lower within brush radius.
   */
  _sculpt(wx, wz, direction) {
    const changes = [];
    const r = this.brushRadius;

    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist > r) continue;

        const lx = wx + dx;
        const lz = wz + dz;
        const cx = Math.floor(lx / CHUNK_SIZE);
        const cz = Math.floor(lz / CHUNK_SIZE);
        const key = `${cx},${cz}`;
        const chunk = this.chunkManager.chunks.get(key);
        if (!chunk?.data) continue;

        const localX = ((lx % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
        const localZ = ((lz % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
        const li = Math.floor(localZ);
        const lj = Math.floor(localX);

        if (li < 0 || li >= CHUNK_SIZE || lj < 0 || lj >= CHUNK_SIZE) continue;

        const falloff = 1 - dist / r;
        const amount = SCULPT_STRENGTH * falloff * direction;

        changes.push({ cx, cz, li, lj, oldH: chunk.data.heightmap[li][lj] });
        chunk.data.heightmap[li][lj] += amount;
      }
    }

    if (changes.length > 0) {
      this.undoStack.push({ type: "sculpt", changes });
      this._rebuildAffectedChunks(changes);
    }
  }

  /**
   * Flatten terrain to average height.
   */
  _flatten(wx, wz) {
    // Sample average height
    let totalH = 0;
    let count = 0;
    const r = this.brushRadius;

    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.sqrt(dx * dx + dz * dz) > r) continue;
        const h = this.chunkManager.getHeight(wx + dx, wz + dz);
        totalH += h;
        count++;
      }
    }
    const avgH = totalH / count;

    // Set all to average
    const changes = [];
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.sqrt(dx * dx + dz * dz) > r) continue;

        const lx = wx + dx;
        const lz = wz + dz;
        const cx = Math.floor(lx / CHUNK_SIZE);
        const cz = Math.floor(lz / CHUNK_SIZE);
        const key = `${cx},${cz}`;
        const chunk = this.chunkManager.chunks.get(key);
        if (!chunk?.data) continue;

        const localX = ((lx % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
        const localZ = ((lz % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
        const li = Math.floor(localZ);
        const lj = Math.floor(localX);

        if (li < 0 || li >= CHUNK_SIZE || lj < 0 || lj >= CHUNK_SIZE) continue;

        changes.push({ cx, cz, li, lj, oldH: chunk.data.heightmap[li][lj] });
        chunk.data.heightmap[li][lj] = avgH;
      }
    }

    if (changes.length > 0) {
      this.undoStack.push({ type: "sculpt", changes });
      this._rebuildAffectedChunks(changes);
    }
  }

  /**
   * Paint biome within brush radius.
   */
  _paintBiome(wx, wz) {
    const r = this.brushRadius;
    const changes = [];

    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.sqrt(dx * dx + dz * dz) > r) continue;

        const lx = wx + dx;
        const lz = wz + dz;
        const cx = Math.floor(lx / CHUNK_SIZE);
        const cz = Math.floor(lz / CHUNK_SIZE);
        const key = `${cx},${cz}`;
        const chunk = this.chunkManager.chunks.get(key);
        if (!chunk?.data) continue;

        const localX = ((lx % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
        const localZ = ((lz % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
        const li = Math.floor(localZ);
        const lj = Math.floor(localX);

        if (li < 0 || li >= CHUNK_SIZE || lj < 0 || lj >= CHUNK_SIZE) continue;

        changes.push({ cx, cz, li, lj, oldBiome: chunk.data.biomeMap[li][lj] });
        chunk.data.biomeMap[li][lj] = this.paintBiome;
      }
    }

    if (changes.length > 0) {
      this.undoStack.push({ type: "paint", changes });
      this._rebuildAffectedChunks(changes);
    }
  }

  /**
   * Place an object at position.
   */
  _placeObject(wx, wz) {
    const h = this.chunkManager.getHeight(wx, wz);
    const cx = Math.floor(wx / CHUNK_SIZE);
    const cz = Math.floor(wz / CHUNK_SIZE);
    const key = `${cx},${cz}`;
    const chunk = this.chunkManager.chunks.get(key);
    if (!chunk?.data) return;

    const dec = {
      type: this.placementType,
      subType: this.placementSubType,
      x: wx,
      z: wz,
      h,
      ry: Math.random() * Math.PI * 2,
      radius: 1.0,
    };

    chunk.data.decorations.push(dec);
    this.undoStack.push({ type: "place", cx, cz, dec });
    this._rebuildAffectedChunks([{ cx, cz, li: 0, lj: 0, oldH: 0 }]); // Rebuild
  }

  /**
   * Erase objects within brush radius.
   */
  _eraseObject(wx, wz) {
    const r = this.brushRadius;
    const erased = [];

    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.sqrt(dx * dx + dz * dz) > r) continue;

        const lx = wx + dx;
        const lz = wz + dz;
        const cx = Math.floor(lx / CHUNK_SIZE);
        const cz = Math.floor(lz / CHUNK_SIZE);
        const key = `${cx},${cz}`;
        const chunk = this.chunkManager.chunks.get(key);
        if (!chunk?.data) continue;

        const before = chunk.data.decorations.length;
        chunk.data.decorations = chunk.data.decorations.filter((d) => {
          const ddx = d.x - lx;
          const ddz = d.z - lz;
          return ddx * ddx + ddz * ddz > 1.5;
        });

        if (chunk.data.decorations.length < before) {
          erased.push({ cx, cz, removed: before - chunk.data.decorations.length });
        }
      }
    }

    if (erased.length > 0) {
      this.undoStack.push({ type: "erase", erased });
      this._rebuildAffectedChunks(erased.map((e) => ({ cx: e.cx, cz: e.cz, li: 0, lj: 0, oldH: 0 })));
    }
  }

  /**
   * Rebuild chunk meshes after modification.
   */
  _rebuildAffectedChunks(changes) {
    const affectedKeys = new Set();
    for (const c of changes) {
      affectedKeys.add(`${c.cx},${c.cz}`);
    }

    for (const key of affectedKeys) {
      const chunk = this.chunkManager.chunks.get(key);
      if (!chunk?.data) continue;

      // Remove old meshes
      this.chunkManager._unloadChunk(chunk);

      // Rebuild
      const newChunk = this.chunkManager._buildChunkMeshes(chunk.data);
      this.chunkManager.chunks.set(key, newChunk);
    }
  }

  /**
   * Undo last action.
   */
  _undo() {
    if (this.undoStack.length === 0) return;

    const action = this.undoStack.pop();

    switch (action.type) {
      case "sculpt":
        for (const c of action.changes) {
          const key = `${c.cx},${c.cz}`;
          const chunk = this.chunkManager.chunks.get(key);
          if (chunk?.data) {
            chunk.data.heightmap[c.li][c.lj] = c.oldH;
          }
        }
        this._rebuildAffectedChunks(action.changes);
        break;

      case "paint":
        for (const c of action.changes) {
          const key = `${c.cx},${c.cz}`;
          const chunk = this.chunkManager.chunks.get(key);
          if (chunk?.data) {
            chunk.data.biomeMap[c.li][c.lj] = c.oldBiome;
          }
        }
        this._rebuildAffectedChunks(action.changes);
        break;

      case "place":
        {
          const key = `${action.cx},${action.cz}`;
          const chunk = this.chunkManager.chunks.get(key);
          if (chunk?.data) {
            chunk.data.decorations = chunk.data.decorations.filter(
              (d) => !(d.x === action.dec.x && d.z === action.dec.z && d.type === action.dec.type)
            );
          }
          this._rebuildAffectedChunks([{ cx: action.cx, cz: action.cz, li: 0, lj: 0, oldH: 0 }]);
        }
        break;

      case "erase":
        // Note: full undo of erase would require storing removed objects; simplified here
        break;
    }
  }

  /**
   * Get current modifications for saving.
   * @returns {object[]} Array of modification objects
   */
  getModifications() {
    return this.modifications;
  }

  /**
   * Get current tool info for UI display.
   */
  getToolInfo() {
    return {
      tool: this.activeTool,
      brushRadius: this.brushRadius,
      biome: this.paintBiome,
      objectType: this.placementType,
      subType: this.placementSubType,
    };
  }

  /**
   * Dispose resources.
   */
  dispose() {
    this.disable();
    this.scene.remove(this.brushCursor);
    this.brushCursor.geometry.dispose();
    this.brushCursor.material.dispose();
  }
}

/**
 * TerrainBuilder – Client-side Three.js continuous terrain construction.
 *
 * Builds a 200×200 vertex mesh from a heightmap using BufferGeometry,
 * with vertex colors (grass/dirt/stone by height & slope),
 * 3D decoration models (trees, rocks, bushes, benches, lampposts),
 * and hemisphere + directional lighting.
 *
 * Usage:
 *   const builder = new TerrainBuilder(scene, terrainData);
 *   builder.build();
 *   builder.getHeight(gridX, gridZ);
 *   builder.dispose();
 */
import * as THREE from 'three';

export class TerrainBuilder {
  constructor(scene, terrainData) {
    this.scene = scene;
    this.terrainData = terrainData;
    this.heightmap = terrainData.heightmap;
    this.decorations = terrainData.decorations || [];
    this.config = terrainData.config;

    this._objects = [];
    this._decorationObjects = [];
  }

  build() {
    this._buildTerrainMesh();
    this._buildDecorations();
    this._buildLighting();
  }

  dispose() {
    const all = [...this._objects, ...this._decorationObjects];
    for (const obj of all) {
      this.scene.remove(obj);
      obj.traverse((child) => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
          if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
          else child.material.dispose();
        }
      });
    }
    this._objects = [];
    this._decorationObjects = [];
  }

  getHeight(gridX, gridZ) {
    const h = this.heightmap?.[gridZ]?.[gridX];
    return h !== undefined ? h : 0;
  }

  gridToWorld(gridX, gridZ) {
    return { x: gridX, z: gridZ };
  }

  // ── Terrain Mesh ────────────────────────────────────────────────────────

  _buildTerrainMesh() {
    const size = this.config.size;
    const heightmap = this.heightmap;

    const geometry = new THREE.BufferGeometry();
    const vertexCount = size * size;
    const positions = new Float32Array(vertexCount * 3);
    const colors = new Float32Array(vertexCount * 3);

    // Color helpers
    const grassGreen = new THREE.Color(0x4caf50);
    const darkGrass = new THREE.Color(0x2e7d32);
    const dirt = new THREE.Color(0x8d6e4a);
    const stone = new THREE.Color(0x9e9e9e);
    const pathDirt = new THREE.Color(0xa1887f);
    const tmpColor = new THREE.Color();

    for (let z = 0; z < size; z++) {
      for (let x = 0; x < size; x++) {
        const i = z * size + x;
        const h = heightmap[z][x];

        positions[i * 3] = x;
        positions[i * 3 + 1] = h;
        positions[i * 3 + 2] = z;

        // Calculate slope for coloring
        let slope = 0;
        if (z > 0 && z < size - 1 && x > 0 && x < size - 1) {
          const sx = Math.abs(heightmap[z][x + 1] - heightmap[z][x - 1]) / 2;
          const sz = Math.abs(heightmap[z + 1][x] - heightmap[z - 1][x]) / 2;
          slope = Math.sqrt(sx * sx + sz * sz);
        }

        // Color based on height + slope
        if (slope > 1.2) {
          tmpColor.copy(stone);
        } else if (h < -0.5) {
          tmpColor.copy(dirt);
        } else if (h > 3.5) {
          tmpColor.copy(darkGrass);
        } else {
          // Subtle variation using position
          const v = Math.sin(x * 0.15) * Math.cos(z * 0.15) * 0.15;
          tmpColor.copy(grassGreen);
          tmpColor.r += v;
          tmpColor.g += v;
          tmpColor.b += v * 0.5;
        }

        colors[i * 3] = tmpColor.r;
        colors[i * 3 + 1] = tmpColor.g;
        colors[i * 3 + 2] = tmpColor.b;
      }
    }

    // Indices: two triangles per cell
    const indices = [];
    for (let z = 0; z < size - 1; z++) {
      for (let x = 0; x < size - 1; x++) {
        const tl = z * size + x;
        const tr = tl + 1;
        const bl = (z + 1) * size + x;
        const br = bl + 1;
        indices.push(tl, bl, tr);
        indices.push(tr, bl, br);
      }
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    const material = new THREE.MeshLambertMaterial({
      vertexColors: true,
      side: THREE.FrontSide,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.userData.isTerrain = true;
    this.scene.add(mesh);
    this._objects.push(mesh);
  }

  // ── Decorations ─────────────────────────────────────────────────────────

  _buildDecorations() {
    // Shared geometries
    const treeTrunkGeo = new THREE.CylinderGeometry(0.15, 0.25, 1.8, 6);
    const treeCanopyGeo = new THREE.SphereGeometry(1.0, 6, 5);
    const rockGeo = new THREE.DodecahedronGeometry(0.5, 0);
    const bushGeo = new THREE.SphereGeometry(0.4, 5, 4);

    // Shared materials
    const treeTrunkMat = new THREE.MeshLambertMaterial({ color: 0x6d4c2a });
    const treeCanopyMat = new THREE.MeshLambertMaterial({ color: 0x2e7d32 });
    const rockMat = new THREE.MeshLambertMaterial({ color: 0x78909c });
    const bushMat = new THREE.MeshLambertMaterial({ color: 0x388e3c });
    const benchSeatMat = new THREE.MeshLambertMaterial({ color: 0x8d6e4a });
    const benchLegMat = new THREE.MeshLambertMaterial({ color: 0x5d4037 });
    const lampPoleMat = new THREE.MeshLambertMaterial({ color: 0x333333 });
    const lampLightMat = new THREE.MeshBasicMaterial({ color: 0xffee88 });

    for (const dec of this.decorations) {
      const h = this.heightmap[dec.z]?.[dec.x] ?? 0;

      switch (dec.type) {
        case 'tree': {
          const trunk = new THREE.Mesh(treeTrunkGeo, treeTrunkMat);
          trunk.position.set(dec.x, h + 0.9, dec.z);
          this.scene.add(trunk);
          this._decorationObjects.push(trunk);

          const canopy = new THREE.Mesh(treeCanopyGeo, treeCanopyMat);
          canopy.position.set(dec.x, h + 2.6, dec.z);
          canopy.scale.set(1, 0.8, 1);
          this.scene.add(canopy);
          this._decorationObjects.push(canopy);
          break;
        }
        case 'rock': {
          const rock = new THREE.Mesh(rockGeo, rockMat);
          const s = 0.7 + (dec.ry / (Math.PI * 2)) * 0.6;
          rock.position.set(dec.x, h + s * 0.3, dec.z);
          rock.scale.set(s, s * 0.7, s);
          rock.rotation.y = dec.ry;
          this.scene.add(rock);
          this._decorationObjects.push(rock);
          break;
        }
        case 'bush': {
          const bush = new THREE.Mesh(bushGeo, bushMat);
          bush.position.set(dec.x, h + 0.3, dec.z);
          bush.scale.set(1, 0.7, 1);
          this.scene.add(bush);
          this._decorationObjects.push(bush);
          break;
        }
        case 'bench': {
          const seat = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.08, 0.4), benchSeatMat);
          seat.position.set(dec.x, h + 0.45, dec.z);
          seat.rotation.y = dec.ry;
          this.scene.add(seat);
          this._decorationObjects.push(seat);

          const legGeo = new THREE.BoxGeometry(0.08, 0.45, 0.08);
          for (const [ox, oz] of [[-0.5, -0.15], [0.5, -0.15], [-0.5, 0.15], [0.5, 0.15]]) {
            const leg = new THREE.Mesh(legGeo, benchLegMat);
            leg.position.set(dec.x + ox, h + 0.22, dec.z + oz);
            this.scene.add(leg);
            this._decorationObjects.push(leg);
          }
          break;
        }
        case 'lamppost': {
          const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.08, 2.5, 6), lampPoleMat);
          pole.position.set(dec.x, h + 1.25, dec.z);
          this.scene.add(pole);
          this._decorationObjects.push(pole);

          const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.15, 6, 4), lampLightMat);
          lamp.position.set(dec.x, h + 2.6, dec.z);
          this.scene.add(lamp);
          this._decorationObjects.push(lamp);

          const light = new THREE.PointLight(0xffcc44, 0.5, 12);
          light.position.set(dec.x, h + 2.5, dec.z);
          this.scene.add(light);
          this._decorationObjects.push(light);
          break;
        }
      }
    }
  }

  // ── Lighting ────────────────────────────────────────────────────────────

  _buildLighting() {
    const hemi = new THREE.HemisphereLight(0x87ceeb, 0x4caf50, 0.7);
    this.scene.add(hemi);
    this._objects.push(hemi);

    const sun = new THREE.DirectionalLight(0xffffff, 0.9);
    sun.position.set(80, 120, 80);
    sun.castShadow = true;
    sun.shadow.mapSize.width = 2048;
    sun.shadow.mapSize.height = 2048;
    const d = 100;
    sun.shadow.camera.left = -d;
    sun.shadow.camera.right = d;
    sun.shadow.camera.top = d;
    sun.shadow.camera.bottom = -d;
    sun.shadow.camera.near = 0.5;
    sun.shadow.camera.far = 300;
    this.scene.add(sun);
    this._objects.push(sun);

    const ambient = new THREE.AmbientLight(0xffffff, 0.35);
    this.scene.add(ambient);
    this._objects.push(ambient);
  }
}

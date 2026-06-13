import * as THREE from 'three';

const shared = {
  trunkMat: null,
  canopyMat: null,
  stoneMat: null,
  waterMat: null,
};

function getShared() {
  if (!shared.trunkMat) {
    shared.trunkMat = new THREE.MeshLambertMaterial({ color: 0x5d4037 });
    shared.canopyMat = new THREE.MeshLambertMaterial({ color: 0x2e7d32 });
    shared.stoneMat = new THREE.MeshLambertMaterial({ color: 0x78909c });
    shared.waterMat = new THREE.MeshLambertMaterial({
      color: 0x42a5f5,
      transparent: true,
      opacity: 0.7,
    });
  }
  return shared;
}

export const PREFABS = {
  fountain: {
    build(scene, { x, z, h, scale = 1 }) {
      const mat = getShared();
      const group = new THREE.Group();
      const pillar = new THREE.Mesh(
        new THREE.CylinderGeometry(0.6 * scale, 0.8 * scale, 1.2 * scale, 8),
        mat.stoneMat,
      );
      pillar.position.set(0, 0.6 * scale, 0);
      pillar.castShadow = true;
      group.add(pillar);
      const basin = new THREE.Mesh(
        new THREE.CylinderGeometry(1.5 * scale, 1.2 * scale, 0.3 * scale, 12),
        mat.stoneMat,
      );
      basin.position.set(0, 0.1 * scale, 0);
      basin.castShadow = true;
      group.add(basin);
      const water = new THREE.Mesh(
        new THREE.CylinderGeometry(1.3 * scale, 1.3 * scale, 0.1 * scale, 12),
        mat.waterMat,
      );
      water.position.set(0, 0.25 * scale, 0);
      group.add(water);
      group.position.set(x, h, z);
      return group;
    },
    collisionRadius: 2,
  },

  big_tree: {
    type: 'tree',
    subType: 'oak',
    scale: 1.5,
    collisionRadius: 2.5,
  },

  statue: {
    build(scene, { x, z, h, scale = 1 }) {
      const mat = getShared();
      const group = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(0.5 * scale, 0.7 * scale, 1.8 * scale, 6),
        mat.stoneMat,
      );
      body.position.set(0, 0.9 * scale, 0);
      body.castShadow = true;
      group.add(body);
      const head = new THREE.Mesh(
        new THREE.SphereGeometry(0.35 * scale, 6, 5),
        mat.stoneMat,
      );
      head.position.set(0, 1.8 * scale, 0);
      head.castShadow = true;
      group.add(head);
      group.position.set(x, h, z);
      return group;
    },
    collisionRadius: 1.2,
  },

  campfire: {
    build(scene, { x, z, h, scale = 1 }) {
      const group = new THREE.Group();
      const logs = new THREE.Mesh(
        new THREE.CylinderGeometry(0.1 * scale, 0.12 * scale, 0.4 * scale, 4),
        new THREE.MeshLambertMaterial({ color: 0x5d4037 }),
      );
      logs.rotation.z = Math.PI / 4;
      logs.position.set(0, 0.2 * scale, 0);
      logs.castShadow = true;
      group.add(logs);
      const logs2 = logs.clone();
      logs2.rotation.z = -Math.PI / 4;
      group.add(logs2);
      const fire = new THREE.Mesh(
        new THREE.ConeGeometry(0.3 * scale, 0.5 * scale, 6),
        new THREE.MeshBasicMaterial({ color: 0xff6600 }),
      );
      fire.position.set(0, 0.5 * scale, 0);
      group.add(fire);
      const glow = new THREE.Mesh(
        new THREE.SphereGeometry(0.5 * scale, 6, 5),
        new THREE.MeshBasicMaterial({
          color: 0xff4400,
          transparent: true,
          opacity: 0.2,
        }),
      );
      glow.position.set(0, 0.3 * scale, 0);
      group.add(glow);
      group.position.set(x, h, z);
      return group;
    },
    collisionRadius: 0.8,
  },
};

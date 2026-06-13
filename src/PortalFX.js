import * as THREE from 'three';

const shared = {
  ringMat: null,
  glowMat: null,
  ringGeo: null,
};

function getShared() {
  if (!shared.ringMat) {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0, 'rgba(139, 92, 246, 0.8)');
    gradient.addColorStop(0.3, 'rgba(139, 92, 246, 0.3)');
    gradient.addColorStop(1, 'rgba(139, 92, 246, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 128, 128);
    const texture = new THREE.CanvasTexture(canvas);

    shared.ringMat = new THREE.MeshBasicMaterial({
      color: 0x8b5cf6,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
    });
    shared.glowMat = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    shared.ringGeo = new THREE.TorusGeometry(1.2, 0.12, 10, 24);
    shared.ringGeo2 = new THREE.TorusGeometry(1.0, 0.08, 10, 24);
  }
  return shared;
}

export class PortalFX {
  constructor() {
    this.group = null;
    this.ringOuter = null;
    this.ringInner = null;
    this.glow = null;
  }

  build(scene, x, y, z) {
    const s = getShared();
    this.group = new THREE.Group();

    this.ringOuter = new THREE.Mesh(s.ringGeo, s.ringMat);
    this.ringOuter.rotation.x = Math.PI / 2;
    this.group.add(this.ringOuter);

    this.ringInner = new THREE.Mesh(s.ringGeo2, s.ringMat);
    this.ringInner.rotation.x = Math.PI / 2;
    this.ringInner.material = s.ringMat.clone();
    this.ringInner.material.color.setHex(0xa78bfa);
    this.ringInner.material.opacity = 0.6;
    this.group.add(this.ringInner);

    this.glow = new THREE.Sprite(s.glowMat);
    this.glow.scale.set(3.5, 3.5, 1);
    this.glow.position.y = 0.2;
    this.group.add(this.glow);

    this.group.position.set(x, y + 0.8, z);
    scene.add(this.group);
    return this;
  }

  dispose(scene) {
    if (this.group) {
      scene.remove(this.group);
      this.group = null;
    }
  }

  update(time) {
    if (!this.group) return;
    this.ringOuter.rotation.z = time * 1.2;
    this.ringInner.rotation.z = -time * 1.6;
    const pulse = 0.85 + Math.sin(time * 3) * 0.12;
    this.ringOuter.material.opacity = pulse;
    this.ringInner.material.opacity = pulse * 0.7;
    this.glow.scale.setScalar(3.5 + Math.sin(time * 2) * 0.3);
  }
}

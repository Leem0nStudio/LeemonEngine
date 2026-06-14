import { useRef, useCallback, useEffect } from 'react';
import * as THREE from 'three';

export interface CameraConfig {
  viewSize?: number;
  minZoom?: number;
  maxZoom?: number;
  near?: number;
  far?: number;
  angle?: number;
}

export function useRagnarokCamera(config: CameraConfig = {}) {
  const {
    viewSize: initialViewSize = 70,
    minZoom = 20,
    maxZoom = 150,
    near = 0.1,
    far = 500,
    angle = Math.PI / 4,
  } = config;

  const cameraRef = useRef<THREE.OrthographicCamera | null>(null);
  const viewSizeRef = useRef(initialViewSize);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const targetRef = useRef<THREE.Vector3>(new THREE.Vector3(100, 0, 100));

  const updateProjection = useCallback(() => {
    const cam = cameraRef.current;
    const el = mountRef.current;
    if (!cam || !el) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    const a = w / h;
    const vs = viewSizeRef.current;
    cam.left = -vs * a / 2;
    cam.right = vs * a / 2;
    cam.top = vs / 2;
    cam.bottom = -vs / 2;
    cam.updateProjectionMatrix();
  }, []);

  const init = useCallback((scene: THREE.Scene, el: HTMLDivElement) => {
    mountRef.current = el;
    const w = el.clientWidth;
    const h = el.clientHeight;
    const a = w / h;
    const vs = viewSizeRef.current;

    const cam = new THREE.OrthographicCamera(
      -vs * a / 2, vs * a / 2,
      vs / 2, -vs / 2,
      near, far,
    );
    cam.position.set(140, 40, 140);
    cam.lookAt(100, 0, 100);
    scene.add(cam);
    cameraRef.current = cam;

    return cam;
  }, [near, far]);

  const follow = useCallback((x: number, z: number, h: number) => {
    targetRef.current.set(x, h, z);
    const cam = cameraRef.current;
    if (!cam) return;
    const offset = 35;
    cam.position.set(x + offset, h + offset, z + offset);
    cam.lookAt(x, h, z);
  }, []);

  const zoom = useCallback((delta: number) => {
    viewSizeRef.current = Math.max(minZoom, Math.min(maxZoom, viewSizeRef.current + delta));
    updateProjection();
  }, [minZoom, maxZoom, updateProjection]);

  const setZoom = useCallback((v: number) => {
    viewSizeRef.current = Math.max(minZoom, Math.min(maxZoom, v));
    updateProjection();
  }, [minZoom, maxZoom, updateProjection]);

  useEffect(() => {
    const el = mountRef.current;
    if (!el || !cameraRef.current) return;

    let touchDist = 0;
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        touchDist = Math.sqrt(dx * dx + dy * dy);
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const newDist = Math.sqrt(dx * dx + dy * dy);
        const scale = touchDist / newDist;
        viewSizeRef.current = Math.max(minZoom, Math.min(maxZoom, viewSizeRef.current * scale));
        touchDist = newDist;
        updateProjection();
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoom(e.deltaY * 0.15);
    };
    const onResize = () => updateProjection();

    el.addEventListener('touchstart', onTouchStart, { passive: false });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('resize', onResize);

    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('wheel', onWheel);
      window.removeEventListener('resize', onResize);
    };
  }, [minZoom, maxZoom, updateProjection, zoom]);

  const dispose = useCallback(() => {
    if (cameraRef.current) {
      cameraRef.current.removeFromParent?.();
      cameraRef.current = null;
    }
  }, []);

  return {
    cameraRef,
    mountRef,
    init,
    follow,
    zoom,
    setZoom,
    updateProjection,
    dispose,
    get viewSize() { return viewSizeRef.current; },
  };
}

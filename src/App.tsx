/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';

export default function App() {
  const mountRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState('Disconnected');
  const [joined, setJoined] = useState(false);
  const [characterId, setCharacterId] = useState('');
  const ws = useRef<WebSocket | null>(null);

  // THREE.js state
  const sceneRef = useRef<THREE.Scene | null>(null);
  const playersRef = useRef<Map<string, THREE.Mesh>>(new Map());
  const cameraRef = useRef<THREE.OrthographicCamera | null>(null);
  const groundRef = useRef<THREE.Mesh | null>(null);

  useEffect(() => {
    ws.current = new WebSocket(`ws://${window.location.host}`);
    ws.current.onopen = () => setStatus('Connected');
    ws.current.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'init') {
            setJoined(true);
            // Render initial players ...
        } else if (msg.type === 'moved') {
            updatePlayerPosition(msg.id, msg.x, msg.z);
        }
    };
    ws.current.onclose = () => setStatus('Disconnected');
    return () => { ws.current?.close(); };
  }, []);

  const updatePlayerPosition = (id: string, x: number, z: number) => {
    if (!sceneRef.current) return;
    let mesh = playersRef.current.get(id);
    if (!mesh) {
        mesh = new THREE.Mesh(
            new THREE.SphereGeometry(0.5),
            new THREE.MeshBasicMaterial({ color: Math.random() * 0xffffff })
        );
        sceneRef.current.add(mesh);
        playersRef.current.set(id, mesh);
    }
    mesh.position.set(x, 1, z);
  };

  useEffect(() => {
    if (!joined || !mountRef.current) return;

    const scene = new THREE.Scene();
    sceneRef.current = scene;
    const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 1000);
    camera.position.set(10, 10, 10);
    camera.lookAt(0, 0, 0);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(mountRef.current.clientWidth, mountRef.current.clientHeight);
    mountRef.current.appendChild(renderer.domElement);

    const ground = new THREE.Mesh(
        new THREE.PlaneGeometry(20, 20),
        new THREE.MeshBasicMaterial({ color: 0x4a5568 })
    );
    ground.rotation.x = -Math.PI / 2;
    groundRef.current = ground;
    scene.add(ground);

    // Raycaster
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    const handleClick = (event: MouseEvent) => {
        if (!mountRef.current || !cameraRef.current || !groundRef.current) return;
        const rect = mountRef.current.getBoundingClientRect();
        pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        
        raycaster.setFromCamera(pointer, cameraRef.current);
        const intersects = raycaster.intersectObject(groundRef.current);
        if (intersects.length > 0) {
            const { x, z } = intersects[0].point;
            ws.current?.send(JSON.stringify({ type: 'move', x: Math.round(x), z: Math.round(z) }));
        }
    };
    mountRef.current.addEventListener('click', handleClick);

    function animate() {
      requestAnimationFrame(animate);
      renderer.render(scene, camera);
    }
    animate();

    return () => { 
        mountRef.current?.removeEventListener('click', handleClick);
        if (mountRef.current && renderer.domElement.parentNode === mountRef.current) {
            mountRef.current.removeChild(renderer.domElement);
        }
    };
  }, [joined]);

  const handleJoin = () => {
    if (ws.current) {
        ws.current.send(JSON.stringify({ type: 'join', userId: 'user-' + Date.now(), characterId }));
    }
  };

  return (
    <div className="w-full h-screen bg-gray-900">
      {!joined ? (
        <div className="flex flex-col justify-center items-center h-full gap-4">
            <h1 className="text-white text-2xl font-bold">Ragnarok 2.5D</h1>
            <input 
                className="p-2 rounded text-black"
                placeholder="Enter Character ID" 
                value={characterId}
                onChange={(e) => setCharacterId(e.target.value)}
            />
            <button className="bg-blue-500 text-white p-2 rounded" onClick={handleJoin}>Join Game</button>
            <p className="text-white">Status: {status}</p>
        </div>
      ) : (
        <div ref={mountRef} className="w-full h-full" />
      )}
    </div>
  );
}

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState, FormEvent, useCallback } from 'react';
import * as THREE from 'three';
import { createClient, type SupabaseClient, type User, type Session, type RealtimeChannel } from '@supabase/supabase-js';

import characterTextureUrl from './assets/character.png';
import { TerrainBuilder } from './TerrainBuilder';
import { ChunkManager } from './ChunkManager';
import { MapEditor } from './MapEditor';
import { DebugUI } from './DebugUI';
import { getMap, DEFAULT_MAP } from '../shared/MapRegistry.js';
import { PortalFX } from './PortalFX.js';

// Initialize Supabase Client
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
const isMockAuth = !supabaseUrl || !supabaseAnonKey;
let supabase: SupabaseClient | null = null;
if (!isMockAuth) {
  supabase = createClient(supabaseUrl, supabaseAnonKey);
}

export default function App() {
  const mountRef = useRef<HTMLDivElement>(null);

  // Auth state
  const [user, setUser] = useState<User | { id: string; email: string } | null>(null);
  const [sessionToken, setSessionToken] = useState<string>('');
  const [characters, setCharacters] = useState<{ id: string; name: string; pos_x?: number; pos_z?: number }[]>([]);
  const [newCharacterName, setNewCharacterName] = useState<string>('');

  // Login / Signup Form State
  const [isLoginView, setIsLoginView] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // Game & Networking State
  const [status, setStatus] = useState('Disconnected');
  const [joined, setJoined] = useState(false);
  const [characterId, setCharacterId] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [playerName, setPlayerName] = useState('');
  const realtimeChannel = useRef<RealtimeChannel | null>(null);

  // THREE.js state
  const sceneRef = useRef<THREE.Scene | null>(null);
  const playersRef = useRef<Map<string, THREE.Group>>(new Map());
  const cameraRef = useRef<THREE.OrthographicCamera | null>(null);

  // Procedural terrain state
  const terrainBuilderRef = useRef<TerrainBuilder | null>(null);
  const chunkManagerRef = useRef<ChunkManager | null>(null);
  const mapEditorRef = useRef<MapEditor | null>(null);
  const mapDataRef = useRef<any>(null);
  const debugUIRef = useRef<DebugUI | null>(null);

  // Sync state refs
  const playersDataRef = useRef<Map<string, { x: number, z: number, name?: string }>>(new Map());
  const charSpriteMaterial = useRef<THREE.SpriteMaterial | null>(null);
  const localPlayerId = useRef<string | null>(null);

  // Map state
  const currentMapId = useRef<string>(DEFAULT_MAP);
  const portalObjects = useRef<PortalFX[]>([]);
  const playerTarget = useRef<{ x: number; z: number } | null>(null);
  const MOVE_SPEED = 4;
  const fadeOverlay = useRef<HTMLDivElement | null>(null);

  // ── Supabase / Mock Auth Session Loader ──
  useEffect(() => {
    if (isMockAuth) {
      const savedUser = localStorage.getItem('mock_user');
      if (savedUser) {
        const parsedUser = JSON.parse(savedUser);
        setUser(parsedUser);
        setSessionToken(parsedUser.id);
        fetchMockCharacters(parsedUser.id);
      }
    } else {
      supabase!.auth.getSession().then(({ data: { session } }: { data: { session: Session | null } }) => {
        if (session) {
          setUser(session.user);
          setSessionToken(session.access_token);
          fetchRealCharacters(session.user.id);
        }
      });
      const { data: { subscription } } = supabase!.auth.onAuthStateChange((_event: string, session: Session | null) => {
        if (session) {
          setUser(session.user);
          setSessionToken(session.access_token);
          fetchRealCharacters(session.user.id);
        } else {
          setUser(null);
          setSessionToken('');
          setCharacters([]);
          setJoined(false);
        }
      });
      return () => { subscription.unsubscribe(); };
    }
  }, []);

  // ── Supabase Realtime Setup ──
  const setupRealtime = useCallback((charId: string, charName: string, startX: number, startZ: number) => {
    if (realtimeChannel.current) {
      supabase?.removeChannel(realtimeChannel.current);
    }

    const channel = supabase!.channel('game:positions', {
      config: { broadcast: { self: false } },
    });

    channel.on('broadcast', { event: 'move' }, (payload) => {
      const { playerId, x, z, name } = payload;
      if (!Number.isFinite(x) || !Number.isFinite(z)) return;
      playersDataRef.current.set(playerId, { x, z, name });
      updatePlayerPosition(playerId, x, z, name);
    });

    channel.on('broadcast', { event: 'join' }, (payload) => {
      const { playerId, x, z, name } = payload;
      if (playerId !== localPlayerId.current) {
        if (!Number.isFinite(x) || !Number.isFinite(z)) return;
        playersDataRef.current.set(playerId, { x, z, name });
        updatePlayerPosition(playerId, x, z, name);
      }
    });

    channel.on('broadcast', { event: 'leave' }, (payload) => {
      removePlayer(payload.playerId);
    });

    channel.subscribe(async (subStatus) => {
      if (subStatus === 'SUBSCRIBED') {
        channel.send({
          type: 'broadcast',
          event: 'join',
          payload: { playerId: charId, x: startX, z: startZ, name: charName },
        });
        setStatus('Online');
      }
    });

    realtimeChannel.current = channel;
  }, []);

  // ── Characters Fetch Helpers ──
  const fetchMockCharacters = (userId: string) => {
    const charsKey = `mock_chars_${userId}`;
    const chars = localStorage.getItem(charsKey);
    if (chars) {
      setCharacters(JSON.parse(chars));
    } else {
      const defaultChar = { id: 'demo-char-id', name: 'Novice Player', pos_x: 2, pos_z: 2 };
      setCharacters([defaultChar]);
      localStorage.setItem(charsKey, JSON.stringify([defaultChar]));
    }
  };

  const fetchRealCharacters = async (userId: string) => {
    try {
      const { data, error } = await supabase!.from('characters').select('*').eq('user_id', userId);
      if (error) console.error("Error fetching characters:", error);
      else setCharacters(data || []);
    } catch (e) { console.error("Fetch exception:", e); }
  };

  // ── Auth Handlers ──
  const handleAuthSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setErrorMessage('');
    if (!email.trim() || !password.trim()) { setErrorMessage("Please fill all fields"); return; }

    if (isMockAuth) {
      const userId = `mock-user-${email.split('@')[0]}`;
      const mockUserObj = { id: userId, email };
      localStorage.setItem('mock_user', JSON.stringify(mockUserObj));
      setUser(mockUserObj);
      setSessionToken(userId);
      fetchMockCharacters(userId);
    } else {
      if (isLoginView) {
        const { error } = await supabase!.auth.signInWithPassword({ email, password });
        if (error) setErrorMessage(error.message);
      } else {
        const { error } = await supabase!.auth.signUp({ email, password });
        if (error) setErrorMessage(error.message);
        else alert("Verification email sent if email confirmation is enabled!");
      }
    }
  };

  const handleSignOut = async () => {
    if (realtimeChannel.current) {
      supabase?.removeChannel(realtimeChannel.current);
      realtimeChannel.current = null;
    }
    setJoined(false);
    setStatus('Disconnected');
    if (isMockAuth) {
      localStorage.removeItem('mock_user');
      setUser(null);
      setSessionToken('');
      setCharacters([]);
    } else {
      await supabase!.auth.signOut();
    }
  };

  // ── Character Creation ──
  const handleCreateCharacter = async () => {
    if (!newCharacterName.trim() || !user) return;
    setErrorMessage('');

    if (isMockAuth) {
      const newChar = { id: `char-${Date.now()}`, name: newCharacterName, pos_x: 2, pos_z: 2 };
      const updated = [...characters, newChar];
      setCharacters(updated);
      localStorage.setItem(`mock_chars_${user.id}`, JSON.stringify(updated));
      setNewCharacterName('');
    } else {
      const { data, error } = await supabase!.from('characters')
        .insert({ user_id: user.id, name: newCharacterName, pos_x: 2, pos_z: 2 })
        .select().single();
      if (error) setErrorMessage(error.message);
      else { setCharacters([...characters, data]); setNewCharacterName(''); }
    }
  };

  const handleSelectCharacter = async (charId: string) => {
    setCharacterId(charId);
    setErrorMessage('');

    let charName = charId;
    let posX = 100;
    let posZ = 100;

    if (isMockAuth) {
      const saved = localStorage.getItem(`mock_chars_${user!.id}`);
      if (saved) {
        const chars = JSON.parse(saved);
        const found = chars.find((c: any) => c.id === charId);
        if (found) {
          charName = found.name;
          posX = (found.pos_x === 2) ? 100 : (found.pos_x ?? 100);
          posZ = (found.pos_z === 2) ? 100 : (found.pos_z ?? 100);
        }
      }
    } else {
      const { data: char } = await supabase!
        .from('characters')
        .select('name, pos_x, pos_z')
        .eq('id', charId)
        .single();
      if (char) {
        charName = char.name;
        posX = (char.pos_x === 2) ? 100 : (char.pos_x ?? 100);
        posZ = (char.pos_z === 2) ? 100 : (char.pos_z ?? 100);
      }
    }

    localPlayerId.current = charId;
    setPlayerName(charName);
    playersDataRef.current.clear();

    currentMapId.current = DEFAULT_MAP;
    const mapDef = getMap(DEFAULT_MAP);
    const spawn = mapDef?.spawnPoint || { x: 100, z: 100 };
    let finalX = (posX === 100 && posZ === 100) ? spawn.x : posX;
    let finalZ = (posZ === 100 && posX === 100) ? spawn.z : posZ;

    playersDataRef.current.set(charId, { x: finalX, z: finalZ, name: charName });

    mapDataRef.current = {
      config: { seed: mapDef?.seed || 42, size: mapDef?.size || 200 },
      spawnPoint: { x: finalX, z: finalZ },
    };

    if (!Number.isFinite(finalX) || !Number.isFinite(finalZ)) {
      console.warn('[App] Invalid spawn position, using default', { finalX, finalZ });
      finalX = 100;
      finalZ = 100;
    }

    if (!isMockAuth) {
      setupRealtime(charId, charName, finalX, finalZ);
    } else {
      setStatus('Offline (mock)');
    }
    setJoined(true);
  };

  const handleLeaveGame = () => {
    if (realtimeChannel.current) {
      realtimeChannel.current.send({
        type: 'broadcast',
        event: 'leave',
        payload: { playerId: localPlayerId.current },
      });
      supabase?.removeChannel(realtimeChannel.current);
      realtimeChannel.current = null;
    }
    setJoined(false);
    setStatus('Disconnected');
    if (chunkManagerRef.current) {
      chunkManagerRef.current.dispose();
      chunkManagerRef.current = null;
    }
    if (mapEditorRef.current) {
      mapEditorRef.current.dispose();
      mapEditorRef.current = null;
    }
    if (terrainBuilderRef.current) {
      terrainBuilderRef.current.dispose();
      terrainBuilderRef.current = null;
    }
    playersRef.current.forEach((group) => sceneRef.current?.remove(group));
    playersRef.current.clear();
    playersDataRef.current.clear();
  };

  // ── Three.js Helpers ──
  const createNameLabel = (name: string) => {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = 'rgba(15, 23, 42, 0.6)';
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(10, 10, 236, 44, 12);
      else ctx.rect(10, 10, 236, 44);
      ctx.fill();
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.font = 'bold 20px Outfit, sans-serif';
      ctx.fillStyle = '#f8fafc';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(name, 128, 32);
    }
    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(1.5, 0.375, 1);
    return sprite;
  };

  const updatePlayerPosition = (id: string, gridX: number, gridZ: number, name?: string) => {
    if (!sceneRef.current || !charSpriteMaterial.current) return;
    if (!Number.isFinite(gridX) || !Number.isFinite(gridZ)) {
      console.warn('[App] Ignoring NaN position for player', id, gridX, gridZ);
      return;
    }

    // New terrain: grid coordinates = world coordinates (1 unit per cell)
    const worldX = gridX;
    const worldZ = gridZ;
    const terrainH = chunkManagerRef.current?.getHeight(gridX, gridZ) ?? 0;

    let playerGroup = playersRef.current.get(id);
    if (!playerGroup) {
      playerGroup = new THREE.Group();
      const sprite = new THREE.Sprite(charSpriteMaterial.current);
      sprite.scale.set(1.2, 1.8, 1);
      sprite.position.set(0, 0.9, 0);
      playerGroup.add(sprite);

      const displayName = id === localPlayerId.current ? "You" : (name || `Player ${id.substring(0, 4)}`);
      const label = createNameLabel(displayName);
      label.position.set(0, 2.0, 0);
      playerGroup.add(label);

      sceneRef.current.add(playerGroup);
      playersRef.current.set(id, playerGroup);
    }

    playerGroup.position.set(worldX, terrainH, worldZ);

    // Camera follow local player (isometric angle)
    if (id === localPlayerId.current && cameraRef.current) {
      const camOffset = 35;
      cameraRef.current.position.set(worldX + camOffset, terrainH + camOffset, worldZ + camOffset);
      cameraRef.current.lookAt(worldX, terrainH, worldZ);
    }
  };

  const removePlayer = (id: string) => {
    playersDataRef.current.delete(id);
    const group = playersRef.current.get(id);
    if (group) {
      sceneRef.current?.remove(group);
      playersRef.current.delete(id);
    }
  };

  // ── Map Loading ──
  const loadMap = useCallback((mapId: string, targetX: number, targetZ: number) => {
    const mapDef = getMap(mapId);
    if (!mapDef) return;
    currentMapId.current = mapId;

    // Dispose portal objects
    for (const p of portalObjects.current) {
      p.dispose(sceneRef.current!);
    }
    portalObjects.current = [];

    // Dispose chunk manager
    if (chunkManagerRef.current) {
      chunkManagerRef.current.dispose();
      chunkManagerRef.current = null;
    }

    // Clear all player sprites (keep local player data)
    const localId = localPlayerId.current;
    const localData = localId ? playersDataRef.current.get(localId) : null;
    playersRef.current.forEach((group) => {
      sceneRef.current?.remove(group);
    });
    playersRef.current.clear();
    playersDataRef.current.clear();
    if (localData && localId) {
      playersDataRef.current.set(localId, { ...localData, x: targetX, z: targetZ });
    }

    // Broadcast position change to others
    if (localId && realtimeChannel.current) {
      realtimeChannel.current.send({
        type: 'broadcast',
        event: 'move',
        payload: { playerId: localId, x: targetX, z: targetZ, name: playerName },
      });
    }

    mapDataRef.current = {
      config: { seed: mapDef.seed, size: mapDef.size },
      spawnPoint: { x: targetX, z: targetZ },
    };

    setJoined(false);
    requestAnimationFrame(() => setJoined(true));
  }, [playerName]);

  // ── Fade Transition ──
  const fadeOut = (cb: () => void) => {
    if (fadeOverlay.current) {
      fadeOverlay.current.style.opacity = '1';
      setTimeout(cb, 350);
    } else {
      cb();
    }
  };

  const fadeIn = () => {
    setTimeout(() => {
      if (fadeOverlay.current) fadeOverlay.current.style.opacity = '0';
    }, 100);
  };

  // ── Three.js Canvas Effect ──
  useEffect(() => {
    if (!joined || !mountRef.current || !mapDataRef.current) return;
    const mapData = mapDataRef.current;
    const { config } = mapData;

    // 1. Scene — Ragnarok style: black background, close fog
    const scene = new THREE.Scene();
    sceneRef.current = scene;
    scene.background = new THREE.Color(0x000000);
    scene.fog = new THREE.Fog(0x000000, 25, 70);

    // 2. Lighting — Ragnarok inspired: warm sun, dim ambient, deep shadows
    const hemiLight = new THREE.HemisphereLight(0x87ceeb, 0x2d5a27, 0.5);
    scene.add(hemiLight);

    const sun = new THREE.DirectionalLight(0xffeedd, 1.0);
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
    scene.add(sun);

    const ambient = new THREE.AmbientLight(0x404060, 0.25);
    scene.add(ambient);

    // 3. Camera – orthographic for 2.5D Ragnarok style
    const width = mountRef.current.clientWidth;
    const height = mountRef.current.clientHeight;
    const aspect = width / height;
    let viewSize = 70; // Shows ~70 units of the 200-unit world (zoomable)
    const MIN_ZOOM = 20;
    const MAX_ZOOM = 150;
    const camera = new THREE.OrthographicCamera(
      -viewSize * aspect / 2, viewSize * aspect / 2,
      viewSize / 2, -viewSize / 2,
      0.1, 500,
    );
    cameraRef.current = camera;
    scene.add(camera);

    // 4. Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    mountRef.current.appendChild(renderer.domElement);

    // 5. Build procedural terrain (new chunk-based streaming system)
    const seed = mapData.config?.seed || 42;
    const mapDef = getMap(currentMapId.current);
    const mapConfig = mapDef ? {
      prefabs: mapDef.prefabs,
      blockedDecorations: mapDef.blockedDecorations,
      terrainTexture: mapDef.terrainTexture,
    } : null;
    console.log('[Terrain] Initializing chunk system:', { seed, mapId: currentMapId.current });
    const chunkManager = new ChunkManager(scene, seed, mapConfig);
    // Load initial chunks around spawn
    chunkManager.update(mapData.spawnPoint?.x || 100, mapData.spawnPoint?.z || 100);
    chunkManagerRef.current = chunkManager;
    // Build prefabs (statics placed at fixed world coords)
    chunkManager.buildPrefabs();
    console.log('[Terrain] Chunk system ready. Scene children:', scene.children.length);

    // Initial camera position: look at spawn from isometric angle
    const spawnX = mapData.spawnPoint?.x || 100;
    const spawnZ = mapData.spawnPoint?.z || 100;
    const spawnH = chunkManager.getHeight(spawnX, spawnZ) || 0;
    camera.position.set(spawnX + 40, spawnH + 40, spawnZ + 40);
    camera.lookAt(spawnX, spawnH, spawnZ);

    // 5b. Map Editor (E key toggle)
    const mapEditor = new MapEditor(scene, camera, chunkManager);
    mapEditorRef.current = mapEditor;

    // 5c. Debug UI (Ctrl+D toggle)
    const debugUI = new DebugUI({ scene, seed, chunkManager });
    debugUIRef.current = debugUI;

    // 5d. Build portals for this map
    const mapDef2 = getMap(currentMapId.current);
    if (mapDef2 && mapDef2.portals) {
      for (const portal of mapDef2.portals) {
        const h = chunkManager.getHeight(portal.x, portal.z) || 0;
        const pf = new PortalFX();
        pf.build(scene, portal.x, h, portal.z);
        portalObjects.current.push(pf);
      }
    }

    // 6. Character material
    const textureLoader = new THREE.TextureLoader();
    const characterTexture = textureLoader.load(characterTextureUrl);
    characterTexture.magFilter = THREE.NearestFilter;
    characterTexture.minFilter = THREE.NearestFilter;
    charSpriteMaterial.current = new THREE.SpriteMaterial({
      map: characterTexture,
      transparent: true,
      alphaTest: 0.5, // Higher alpha test to fix edge artifacts
    });

    // 7. Render existing players
    playersDataRef.current.forEach((pos, id) => {
      updatePlayerPosition(id, pos.x, pos.z, pos.name);
    });

    // 8. Raycaster & click-to-move
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    const handleClick = (event: MouseEvent) => {
      if (!mountRef.current || !cameraRef.current) return;
      const rect = mountRef.current.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(pointer, cameraRef.current);

      // Intersect with terrain meshes (InstancedMesh or Mesh with isTerrain)
      const intersects = raycaster.intersectObjects(scene.children, true);
      for (const hit of intersects) {
        if (hit.object instanceof THREE.Mesh && hit.object.userData.isTerrain) {
          const { x, z } = hit.point;
          const gridX = Math.round(x);
          const gridZ = Math.round(z);

          // Basic client-side validation
          const cm = chunkManagerRef.current;
          if (cm) {
            const h = cm.getHeight(gridX, gridZ);
            if (gridX < 0 || gridX >= 200 || gridZ < 0 || gridZ >= 200) break;
            const circles = cm.getCollisionCircles(gridX, gridZ, 3);
            let blocked = false;
            for (const c of circles) {
              const dx = gridX - c.x;
              const dz = gridZ - c.z;
              if (Math.sqrt(dx * dx + dz * dz) < c.radius) { blocked = true; break; }
            }
            if (blocked) break;

            // Set movement target (smooth walking)
            playerTarget.current = { x: gridX, z: gridZ };

            // Portal detection
            const curMap = getMap(currentMapId.current);
            if (curMap && curMap.portals) {
              for (const portal of curMap.portals) {
                const dx = gridX - portal.x;
                const dz = gridZ - portal.z;
                if (Math.sqrt(dx * dx + dz * dz) < 1.5) {
                  fadeOut(() => {
                    loadMap(portal.targetMap, portal.targetX, portal.targetZ);
                    fadeIn();
                  });
                  break;
                }
              }
            }
          }
          break;
        }
      }
    };
    mountRef.current.addEventListener('click', handleClick);

    // 8b. E key to toggle map editor
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'e' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const target = e.target as HTMLElement;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
        if (mapEditorRef.current) {
          mapEditorRef.current.toggle();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);

    // 9. Resize
    const handleResize = () => {
      if (!mountRef.current || !cameraRef.current) return;
      const w = mountRef.current.clientWidth;
      const h = mountRef.current.clientHeight;
      const a = w / h;
      const cam = cameraRef.current;
      cam.left = -viewSize * a / 2;
      cam.right = viewSize * a / 2;
      cam.top = viewSize / 2;
      cam.bottom = -viewSize / 2;
      cam.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener('resize', handleResize);

    // 9b. Touch handlers (mobile)
    let touchDist = 0;
    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        touchDist = Math.sqrt(dx * dx + dy * dy);
      }
    };
    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const newDist = Math.sqrt(dx * dx + dy * dy);
        const scale = touchDist / newDist;
        viewSize = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, viewSize * scale));
        touchDist = newDist;
        const a = (mountRef.current?.clientWidth || 1) / (mountRef.current?.clientHeight || 1);
        camera.left = -viewSize * a / 2;
        camera.right = viewSize * a / 2;
        camera.top = viewSize / 2;
        camera.bottom = -viewSize / 2;
        camera.updateProjectionMatrix();
      }
    };
    mountRef.current.addEventListener('touchstart', handleTouchStart, { passive: false });
    mountRef.current.addEventListener('touchmove', handleTouchMove, { passive: false });

    // 9c. Scroll wheel zoom
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      viewSize = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, viewSize + e.deltaY * 0.15));
      const a = (mountRef.current?.clientWidth || 1) / (mountRef.current?.clientHeight || 1);
      camera.left = -viewSize * a / 2;
      camera.right = viewSize * a / 2;
      camera.top = viewSize / 2;
      camera.bottom = -viewSize / 2;
      camera.updateProjectionMatrix();
    };
    mountRef.current.addEventListener('wheel', handleWheel, { passive: false });

    // 10. Animation loop
    let animationId: number;
    let portalTime = 0;
    let lastBroadcastPos = { x: 0, z: 0 };
    function animate() {
      animationId = requestAnimationFrame(animate);

      // Smooth movement toward target
      const localId = localPlayerId.current;
      const target = playerTarget.current;
      if (target && localId) {
        const pos = playersDataRef.current.get(localId);
        if (pos) {
          const dx = target.x - pos.x;
          const dz = target.z - pos.z;
          const dist = Math.sqrt(dx * dx + dz * dz);
          const cm = chunkManagerRef.current;

          if (dist > 0.5) {
            const step = Math.min(MOVE_SPEED * 0.016, dist);
            const nx = pos.x + (dx / dist) * step;
            const nz = pos.z + (dz / dist) * step;
            const nxi = Math.round(nx);
            const nzi = Math.round(nz);

            // Collision check at next step
            let blocked = false;
            if (cm) {
              const circles = cm.getCollisionCircles(nxi, nzi, 3);
              for (const c of circles) {
                if (Math.sqrt((nxi - c.x) ** 2 + (nzi - c.z) ** 2) < c.radius) {
                  blocked = true;
                  break;
                }
              }
            }

            if (!blocked) {
              pos.x = nx;
              pos.z = nz;
              updatePlayerPosition(localId, nx, nz, pos.name);

              // Throttle broadcasts to avoid spam
              const bd = Math.sqrt((pos.x - lastBroadcastPos.x) ** 2 + (pos.z - lastBroadcastPos.z) ** 2);
              if (bd >= 1) {
                lastBroadcastPos = { x: pos.x, z: pos.z };
                realtimeChannel.current?.send({
                  type: 'broadcast',
                  event: 'move',
                  payload: { playerId: localId, x: Math.round(pos.x), z: Math.round(pos.z), name: pos.name },
                });
              }
            }
          } else {
            // Arrived at target
            playerTarget.current = null;
            // Snap to exact grid position
            pos.x = target.x;
            pos.z = target.z;
            updatePlayerPosition(localId, target.x, target.z, pos.name);
          }
        }
      }

      // Update chunk streaming based on local player position
      const localPlayer = playersDataRef.current.get(localPlayerId.current || '');
      if (localPlayer && chunkManagerRef.current) {
        chunkManagerRef.current.update(localPlayer.x, localPlayer.z);
      }

      // Animate portal glow and rotation
      portalTime += 0.016;
      for (const p of portalObjects.current) {
        p.update(portalTime);
      }

      debugUI.update();
      renderer.render(scene, camera);
    }
    animate();

    return () => {
      cancelAnimationFrame(animationId);
      window.removeEventListener('resize', handleResize);
      mountRef.current?.removeEventListener('click', handleClick);
      mountRef.current?.removeEventListener('touchstart', handleTouchStart);
      mountRef.current?.removeEventListener('touchmove', handleTouchMove);
      mountRef.current?.removeEventListener('wheel', handleWheel);
      document.removeEventListener('keydown', handleKeyDown);

      // Dispose portals
      for (const p of portalObjects.current) {
        p.dispose(scene);
      }
      portalObjects.current = [];

      debugUI.dispose();
      debugUIRef.current = null;
      if (chunkManagerRef.current) {
        chunkManagerRef.current.dispose();
        chunkManagerRef.current = null;
      }
      if (mapEditorRef.current) {
        mapEditorRef.current.dispose();
        mapEditorRef.current = null;
      }
      if (terrainBuilderRef.current) {
        terrainBuilderRef.current.dispose();
        terrainBuilderRef.current = null;
      }
      if (mountRef.current && renderer.domElement.parentNode === mountRef.current) {
        mountRef.current.removeChild(renderer.domElement);
      }
    };
  }, [joined]);

  // ── UI ──
  return (
    <div className="w-full h-screen bg-slate-950 flex flex-col justify-between overflow-hidden relative font-sans text-slate-100">
      {isMockAuth && !joined && (
        <div className="absolute top-0 left-0 right-0 bg-amber-500/10 border-b border-amber-500/20 py-2 px-4 text-center text-xs text-amber-300 z-50 backdrop-blur-sm">
          ⚠️ Modo de prueba (Mock Auth) activo: no se han detectado variables de Supabase en .env.
        </div>
      )}

      {!user ? (
        <div className="flex flex-col justify-center items-center h-full gap-6 px-4 z-10">
          <div className="bg-slate-900/60 backdrop-blur-md border border-slate-800 p-8 rounded-2xl shadow-2xl max-w-md w-full transition-all duration-300 hover:shadow-cyan-950/20">
            <h1 className="text-4xl font-extrabold text-center text-transparent bg-clip-text bg-gradient-to-r from-sky-400 via-teal-200 to-indigo-400 mb-2">
              Ragnarok 2.5D
            </h1>
            <p className="text-slate-400 text-center text-sm mb-6">Manejo de cuentas con Supabase Auth</p>
            <div className="flex border-b border-slate-800 mb-6">
              <button
                className={`w-1/2 pb-3 font-semibold text-sm transition-all border-b-2 ${isLoginView ? 'border-sky-500 text-sky-400' : 'border-transparent text-slate-400 hover:text-slate-200'}`}
                onClick={() => { setIsLoginView(true); setErrorMessage(''); }}
              >Ingresar</button>
              <button
                className={`w-1/2 pb-3 font-semibold text-sm transition-all border-b-2 ${!isLoginView ? 'border-sky-500 text-sky-400' : 'border-transparent text-slate-400 hover:text-slate-200'}`}
                onClick={() => { setIsLoginView(false); setErrorMessage(''); }}
              >Crear Cuenta</button>
            </div>
            <form onSubmit={handleAuthSubmit} className="space-y-4">
              {errorMessage && (
                <div className="bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs p-3 rounded-lg text-center font-medium">{errorMessage}</div>
              )}
              <div>
                <label className="block text-xs font-semibold text-sky-400 uppercase tracking-wider mb-2">Correo Electrónico</label>
                <input type="email" className="w-full bg-slate-950 border border-slate-800 focus:border-sky-500 focus:ring-1 focus:ring-sky-500 p-3 rounded-xl text-slate-100 placeholder-slate-600 focus:outline-none transition-all"
                  placeholder="name@domain.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </div>
              <div>
                <label className="block text-xs font-semibold text-sky-400 uppercase tracking-wider mb-2">Contraseña</label>
                <input type="password" className="w-full bg-slate-950 border border-slate-800 focus:border-sky-500 focus:ring-1 focus:ring-sky-500 p-3 rounded-xl text-slate-100 placeholder-slate-600 focus:outline-none transition-all"
                  placeholder="••••••••" value={password} onChange={(e) => setPassword(e.target.value)} required />
              </div>
              <button type="submit" className="w-full py-3 bg-gradient-to-r from-sky-500 to-indigo-600 hover:from-sky-400 hover:to-indigo-500 active:from-sky-600 active:to-indigo-700 text-white font-bold rounded-xl shadow-lg transition-all transform hover:-translate-y-0.5 active:translate-y-0">
                {isLoginView ? 'Ingresar' : 'Registrar Cuenta'}
              </button>
            </form>
          </div>
        </div>
      ) : !joined ? (
        <div className="flex flex-col justify-center items-center h-full px-4 z-10">
          <div className="bg-slate-900/60 backdrop-blur-md border border-slate-800 p-8 rounded-2xl shadow-2xl max-w-2xl w-full transition-all">
            <div className="flex justify-between items-center mb-6 pb-4 border-b border-slate-800">
              <div>
                <h2 className="text-xl font-bold text-sky-400">Selección de Personaje</h2>
                <p className="text-xs text-slate-400">Usuario: <span className="font-mono text-slate-300">{user.email}</span></p>
              </div>
              <button onClick={handleSignOut} className="px-4 py-2 bg-slate-950 hover:bg-slate-800 text-slate-300 border border-slate-800 text-xs font-bold rounded-xl transition-all">Cerrar Sesión</button>
            </div>
            {errorMessage && (
              <div className="bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs p-3 rounded-lg mb-6 text-center font-medium">{errorMessage}</div>
            )}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-4">
                <h3 className="text-xs font-semibold uppercase text-slate-400 tracking-wider">Tus Personajes</h3>
                <div className="space-y-2.5 max-h-60 overflow-y-auto pr-1">
                  {characters.length === 0 ? (
                    <div className="text-center py-6 text-sm text-slate-500 border border-dashed border-slate-800 rounded-xl">No tienes personajes creados.</div>
                  ) : characters.map((char) => (
                    <div key={char.id} className="bg-slate-950/80 border border-slate-800/80 p-4 rounded-xl flex justify-between items-center hover:border-sky-500/50 transition-all">
                      <div>
                        <div className="font-bold text-slate-100">{char.name}</div>
                        <div className="text-[10px] text-slate-500 font-mono mt-0.5">ID: {char.id.substring(0, 8)}...</div>
                      </div>
                      <button onClick={() => handleSelectCharacter(char.id)}
                        className="px-3.5 py-1.5 bg-sky-500 hover:bg-sky-400 active:bg-sky-600 text-white font-bold text-xs rounded-lg shadow transition-all">Seleccionar</button>
                    </div>
                  ))}
                </div>
              </div>
              <div className="bg-slate-950/40 border border-slate-800/50 p-5 rounded-xl flex flex-col justify-between h-full">
                <div className="space-y-4">
                  <h3 className="text-xs font-semibold uppercase text-sky-400 tracking-wider">Crear Personaje</h3>
                  <div>
                    <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-2">Nombre del Personaje</label>
                    <input type="text" className="w-full bg-slate-950 border border-slate-800 focus:border-sky-500 focus:ring-1 focus:ring-sky-500 p-2.5 rounded-lg text-slate-100 placeholder-slate-600 focus:outline-none text-sm transition-all"
                      placeholder="e.g. NoviceRagnarok" value={newCharacterName} onChange={(e) => setNewCharacterName(e.target.value)} />
                  </div>
                </div>
                <button onClick={handleCreateCharacter} disabled={!newCharacterName.trim()}
                  className="w-full mt-6 py-2.5 bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500 active:from-emerald-600 active:to-teal-700 text-white font-bold text-xs rounded-xl shadow disabled:opacity-50 disabled:pointer-events-none transition-all">Crear Nuevo</button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="w-full h-full relative">
          <div ref={mountRef} className="w-full h-full" />
          <div className="absolute top-4 left-4 bg-slate-950/70 backdrop-blur-sm border border-slate-800 px-4 py-3 rounded-xl pointer-events-none select-none">
            <h2 className="text-sky-400 font-bold text-sm">Ragnarok 2.5D</h2>
            <p className="text-slate-400 text-xs mt-1">
              Personaje: <span className="text-slate-200 font-mono">
                {characters.find(c => c.id === characterId)?.name || characterId}
              </span>
            </p>
            <p className="text-slate-400 text-xs">
              Mapa: <span className="text-emerald-400">{getMap(currentMapId.current)?.name || currentMapId.current}</span>
              {' · '}
              Seed: <span className="text-slate-300 font-mono">{mapDataRef.current?.config?.seed || '—'}</span>
            </p>
            <p className="text-slate-400 text-xs">
               Status: <span className="text-emerald-400">{status}</span>
            </p>
          </div>
          <div className="absolute top-4 right-4 flex gap-2 z-20">
            <button onClick={handleLeaveGame}
              className="px-4 py-2 bg-slate-950/80 hover:bg-slate-800 border border-slate-800 text-xs font-bold rounded-xl transition-all">Volver a Selección</button>
          </div>
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-slate-950/70 backdrop-blur-sm border border-slate-800 px-6 py-2 rounded-full pointer-events-none select-none text-xs text-slate-300">
            🖱️ <strong>Left Click</strong> to move · <strong>E</strong> editor · <strong>Ctrl+D</strong> debug
          </div>
        </div>
      )}
      {/* Fade overlay for map transitions */}
      <div
        ref={fadeOverlay}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'black',
          zIndex: 999,
          opacity: 0,
          transition: 'opacity 0.3s',
          pointerEvents: 'none',
        }}
      />
    </div>
  );
}

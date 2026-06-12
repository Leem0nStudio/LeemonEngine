# Ragnarok Online 2.5D Clone (MVP) with Supabase Auth

This is a 2.5D top-down MMORPG clone featuring Three.js frontend graphics (using 2D billboard sprite characters) and a Node.js WebSocket backend for real-time synchronized movement, collision detection, and user persistence integrated with **Supabase Auth**. The world is built with **procedural continuous terrain generation** — no hardcoded layouts, no tile grids.

---

## Features
- **Account Management**: Safe user sign-in/sign-up forms connected to Supabase Auth.
- **Character Selection**: Create and manage multiple characters linked directly to your authenticated account.
- **Real-time Sync**: Multi-client synchronization via WebSockets.
- **Continuous Terrain**: 200×200 vertex mesh with simplex noise heightmap — rolling hills, paths, and natural topography.
- **3D Decorations**: Trees, rocks, bushes, benches, and lampposts placed deterministically on the terrain.
- **Validations**: Server-side slope validation (45° max), decoration collision circles, and boundary checks.
- **Fallback Mode**: Fully-functional **Mock Auth & Database** fallback mode when no `.env` keys are configured.

---

## Procedural Terrain Generation

### How It Works
Both the server (`backend/terrainGenerator.js`) and the client (`src/TerrainBuilder.js`) share the same deterministic algorithms:
- **Simplex noise** (`simplex-noise` library) for heightmap generation
- **Mulberry32 PRNG** for decoration placement and path generation

When the server generates terrain from a seed, it sends the seed to the client, which rebuilds the exact same terrain locally. This means:
- Collision checks match visual positions
- No geometry is sent over the wire — only a small seed
- Terrain is computed once per unique seed and cached in memory

### Terrain Specs
| Property | Value |
|----------|-------|
| Grid size | 200×200 vertices |
| Cell spacing | 1 unit |
| Total world size | 200×200 units |
| Height range | [-2, 5] |
| Noise frequency | Low (0.01–0.06) for smooth hills |
| Max walkable slope | 45° |

### Decorations
| Type | Collision Radius | Description |
|------|-----------------|-------------|
| Tree | 1.2 | Brown trunk (cylinder) + green canopy (sphere) |
| Rock | 0.8 | Grey dodecahedron |
| Bush | 0.5 | Small green sphere |
| Bench | 1.0 | Wooden seat + legs |
| Lamppost | 0.4 | Metal pole + glowing head + point light |

Decorations are placed deterministically using the seed, with minimum spacing of 3 units and avoidance of steep slopes and low areas.

### Dirt Paths
Generated using random walks (5 paths, 80 steps each). Path cells are 3 units wide and rendered with a brown dirt texture on the terrain mesh.

### Changing the Seed
The default seed is `42`. To change:
- In `server.ts`, modify `startSeed` in the join handler

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Server (server.ts)                                     │
│  ├── terrainGenerator.js  ← simplex noise + PRNG        │
│  ├── Generates 200×200 heightmap from seed              │
│  ├── Places decorations with collision circles           │
│  ├── Validates: slope + collision circles + bounds       │
│  └── Caches terrain in memory per seed                   │
└───────────────────────┬─────────────────────────────────┘
                        │ WebSocket (JSON)
┌───────────────────────▼─────────────────────────────────┐
│  Client (src/App.tsx)                                   │
│  ├── TerrainBuilder.js  ← same algorithms as server     │
│  ├── Builds BufferGeometry mesh (40k vertices)           │
│  ├── Canvas texture (grass/dirt/stone by height/slope)   │
│  ├── 3D decoration models (trees, rocks, etc.)           │
│  ├── Hemisphere + directional lighting + shadows         │
│  └── Character sprites positioned at terrain height      │
└─────────────────────────────────────────────────────────┘
```

### Message Protocol
| Direction | Type | Payload |
|-----------|------|---------|
| C→S | `join` | `{ token, characterId }` |
| C→S | `move` | `{ x, z }` — grid coordinates (0–199) |
| S→C | `init` | `{ player, players, map }` — includes terrain data |
| S→C | `moved` | `{ id, x, z, name? }` |
| S→C | `left` | `{ id }` |
| S→C | `error` | `{ message }` |

### Move Validation (Server)
1. **Bounds check**: x and z must be within [0, 199]
2. **Slope check**: `atan2(heightDiff, horizontalDist)` must be ≤ 45°
3. **Collision check**: Position must not be inside any decoration's bounding circle

---

## Setup Instructions

### 1. Database Configuration (Supabase)
1. Go to your Supabase Dashboard and open the **SQL Editor**.
2. Copy the contents of `supabase-init.sql` and run the script. This will:
   - Create the `characters` table with a foreign key referencing `auth.users`.
   - Enable Row-Level Security (RLS).
   - Configure policies allowing authenticated users to **select**, **insert**, and **update** only their own characters.

### 2. Environment Variables Configuration
Create a `.env` file in the project root containing:

```env
# Backend Database Keys
SUPABASE_URL="https://your-project-id.supabase.co"
SUPABASE_KEY="your-supabase-service-role-key"

# Frontend client-side variables (injected by Vite)
VITE_SUPABASE_URL="https://your-project-id.supabase.co"
VITE_SUPABASE_ANON_KEY="your-supabase-anon-key"
```

> [!NOTE]
> If you leave these variables blank, the application will default to **Mock Auth Mode**. You can sign in using any mock email and create/test characters immediately!

### 3. Start the Server
```bash
npm install
npm run dev
```

Open `http://localhost:3000` in your web browser.

---

## Debug Tools

### DebugUI Panel (Ctrl+D)
Press **Ctrl+D** in-game to toggle a floating debug panel with:
- **Seed display** — view current seed, copy to clipboard
- **Visual overlays** — toggle grid (10-unit), height gradient, collision circles
- **FPS counter** and **object count**

### Overlays
| Overlay | Color | What it shows |
|---------|-------|---------------|
| Grid | Blue 30% opacity | 10-unit grid lines |
| Heights | Blue→Green→Yellow→Red | Height gradient (sampled every 4 units) |
| Collisions | Red rings | Decoration collision circles |

### Map Hash Endpoint
```
GET /api/map/hash?seed=42
```
Returns the MD5 hash of the heightmap for deterministic verification.

### Consistency Test
```bash
node test_map_consistency.js
```
Runs 1074 tests verifying:
- Deterministic generation (same seed → same heightmap)
- Height values within range [-2, 5]
- Decoration placement validity and spacing
- Collision circle consistency
- Slope validation logic
- Spawn point and path validity
- PRNG determinism

# Ragnarok Online 2.5D Clone (MVP) with Supabase Auth

This is a 2.5D top-down MMORPG clone featuring Three.js frontend graphics (using 2D billboard sprite characters) and a Node.js WebSocket backend for real-time synchronized movement, collision detection, and user persistence integrated with **Supabase Auth**. The world is built with **procedural map generation** — no hardcoded layouts.

---

## Features
- **Account Management**: Safe user sign-in/sign-up forms connected to Supabase Auth.
- **Character Selection**: Create and manage multiple characters linked directly to your authenticated account.
- **Real-time Sync**: Multi-client synchronization via WebSockets.
- **Procedural Maps**: Deterministic seed-based terrain generation (field + dungeon) — server and client produce identical worlds from the same seed.
- **Portal System**: Walk onto a red portal to transition between map types in real-time.
- **Validations**: Server-side collision, slope, and boundary validation on every move.
- **Fallback Mode**: Fully-functional **Mock Auth & Database** fallback mode when no `.env` keys are configured.

---

## Procedural Map Generation

### How It Works
Both the server (`backend/mapGenerator.js`) and the client (`src/TerrainBuilder.js`) share the same deterministic noise/PRNG algorithm. When the server generates a map from a seed, it sends the seed + map type to the client, which rebuilds the exact same terrain locally. This means:
- Collision checks match visual positions
- No geometry is sent over the wire — only a small seed + config
- Map generation is computed once per unique seed and cached in memory

### Map Types

| Type | Algorithm | Grid Size | Cell Size | Description |
|------|-----------|-----------|-----------|-------------|
| `field` | Multi-octave value noise | 40×40 | 5 units | Rolling hills with trees (cones+cylinders), rocks, and border walls |
| `dungeon` | BSP room-and-corridor | 30×30 | 10 units | Stone rooms connected by corridors, dark ceiling, point lighting |

### Changing the Seed
The default seed is `42` (field) and `43` (dungeon). To change:
- In `server.ts`, modify `startSeed` in the join handler
- Or pass different seeds through the `targetSeed` field in portal definitions

### Adding New Map Types
1. Add a `generateYourType(seed, width, height)` function in `backend/mapGenerator.js`
2. Register it in the `generateMap()` switch statement
3. Add a `_buildYourType()` method in `src/TerrainBuilder.js`
4. Set the `config.type` field to match

### Portal System
Portals are defined in the map data as `{ x, z, targetMap, targetSeed }`. When a player steps on a portal cell, the server:
1. Generates/retrieves the target map
2. Sends a `map_change` message with the new map data
3. Teleports the player to the target map's spawn point

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Server (server.ts)                                     │
│  ├── mapGenerator.js  ← shared noise/PRNG algorithms   │
│  ├── Generates terrain from seed (cached in memory)     │
│  ├── Validates movement against obstacleMap + heightMap │
│  └── Detects portal collisions → map_change messages    │
└───────────────────────┬─────────────────────────────────┘
                        │ WebSocket (JSON)
┌───────────────────────▼─────────────────────────────────┐
│  Client (src/App.tsx)                                   │
│  ├── TerrainBuilder.js  ← same algorithms as server     │
│  ├── Builds Three.js geometry from seed                 │
│  ├── Field: displaced plane + tree/rock meshes           │
│  ├── Dungeon: floor quads + wall blocks + ceiling        │
│  └── Character sprites positioned at terrain height      │
└─────────────────────────────────────────────────────────┘
```

### Message Protocol
| Direction | Type | Payload |
|-----------|------|---------|
| C→S | `join` | `{ token, characterId }` |
| C→S | `move` | `{ x, z }` |
| S→C | `init` | `{ player, players, map }` — includes full map data |
| S→C | `moved` | `{ id, x, z, name? }` |
| S→C | `map_change` | `{ player, map }` — after portal transition |
| S→C | `left` | `{ id }` |
| S→C | `error` | `{ message }` |

---

## Setup Instructions

### 1. Database Configuration (Supabase)
1. Go to your Supabase Dashboard and open the **SQL Editor**.
2. Copy the contents of [supabase-init.sql](file:///c:/Users/User/Desktop/bruno/MIS%20REPOS/LeemonEngine/supabase-init.sql) and run the script. This will:
   - Create the `characters` table with a foreign key referencing `auth.users`.
   - Enable Row-Level Security (RLS).
   - Configure policies allowing authenticated users to **select**, **insert**, and **update** only their own characters.

### 2. Environment Variables Configuration
Create a `.env` file in the project root containing:

```env
# Backend Database Keys
SUPABASE_URL="https://your-project-id.supabase.co"
SUPABASE_KEY="your-supabase-service-role-key" # Keep it secure! Recommended: use service_role so the game server can update coordinates bypassing RLS.

# Frontend client-side variables (injected by Vite)
VITE_SUPABASE_URL="https://your-project-id.supabase.co"
VITE_SUPABASE_ANON_KEY="your-supabase-anon-key"
```

> [!NOTE]
> If you leave these variables blank, the application will default to **Mock Auth Mode**. You can sign in using any mock email and create/test characters immediately!

### 3. Start the Server
Run the following commands in the project root:
```bash
# Install dependencies
npm install

# Start the dev server (Vite frontend + WebSocket backend)
npm run dev
```

Open `http://localhost:3000` in your web browser.

---

## Row-Level Security (RLS) Configuration
To protect user data, Row-Level Security (RLS) restricts access to database records. In our setup, RLS policies are applied to the `characters` table:

- **SELECT Policy**: Only allows reading if `auth.uid() = user_id`. This means users can only see their own characters in the selection screen.
- **INSERT Policy**: Only allows inserting characters where the `user_id` matches the user's authenticated UID (`auth.uid() = user_id`).
- **UPDATE Policy**: Ensures players can only modify their own characters (`auth.uid() = user_id`).

The WebSocket server verifies this authorization on connection by querying the database using the verified user ID from the Supabase client-side JWT token.

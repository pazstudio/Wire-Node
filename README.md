# Wire-Node

Self-hosted app for documenting machine wiring: projects, component photos (PCBs, motors, power supplies…) with marked connectors,
cables, connectors, pin-to-pin connections and harnesses, and a project-wide wiring map.

## Run with Docker

```sh
docker compose up -d --build
```

Open http://localhost:8080 (or `http://<server-ip>:8080` from a phone on the same network).

Data lives in two Docker volumes:

| Volume    | Contents                          |
|-----------|-----------------------------------|
| `pgdata`  | PostgreSQL database               |
| `uploads` | Component and connector pictures (WebP) |

The database schema is applied automatically on start (`prisma/upgrade.sql`, then `prisma db push`).
Existing data is kept when upgrading.

## Backup and migrating to another server

A backup is a single `.tar.gz` file that holds every database row (as `wire-node.json`) and every
picture (`uploads/`). It does not depend on the PostgreSQL version or on Docker volume names.

**In the browser:** open *Backup & restore* in the top bar.

1. On the old server, click **Download backup**.
2. On the new server, copy this project folder and run `docker compose up -d --build`.
3. Open the new server, go to *Backup & restore*, pick the file and click **Restore**.

**From the command line** (no browser needed):

```sh
# 1. Export from the old server
curl -fo wire-node-backup.tar.gz http://OLD-SERVER:8080/api/backup

# 2. Import into the new, empty server
curl -f -F file=@wire-node-backup.tar.gz http://NEW-SERVER:8080/api/restore

# Overwrite a server that already has data (deletes everything there first)
curl -f -F file=@wire-node-backup.tar.gz "http://NEW-SERVER:8080/api/restore?replace=true"
```

Restore is all-or-nothing for the database: if anything fails, the existing data is kept.
Without `replace=true`, a server that already has data refuses the restore with HTTP 409.

## Develop without Docker

Requirements: Node.js 20+ and a PostgreSQL server.

```sh
# API (http://localhost:8080)
cd server
cp .env.example .env        # adjust DATABASE_URL
npm install
npm run db:push
npm run dev

# Web (http://localhost:5173, proxies /api and /uploads to :8080)
cd web
npm install
npm run dev
```

Checks: `npm run typecheck` in both folders, `npm test` in `server`.

## How it works

In the app, "components" are PCBs, motors, power supplies or any other part with connectors.
Internally (database tables, API paths such as `/api/pcbs`) they are still called PCBs.

- **Library vs project.** Components, cables and connector types are a shared library, and component names
  in it are unique. A project places components under a name of its own; the same component can be placed
  several times (e.g. "Peltier Driver - Toolhead1" and "Peltier Driver - Toolhead2") without uploading it
  again. Connections and map zones belong to one project.
- **Component drawings** store rectangle coordinates normalized to the image size (0..1), so they stay on
  the same spot on any screen. Every change is autosaved (debounced, per connector, in order).
  Uploaded photos are auto-rotated from EXIF so phone pictures line up.
- **Connections** are graphs: connector nodes plus pin-to-pin wires. More than two connectors makes a
  harness; one connector's pins can go to different connectors (splits). Inline connectors or splices
  that are not on a component can be added as "inline" nodes.
- **Project map** shows one block per placed component and one line per block pair that shares wires (followed through
  inline connectors). Zones are semi-transparent rectangles for grouping, such as "Frame" or "Toolhead".

## Stack

React + TypeScript + Vite, react-konva (component photo drawing), React Flow (wizard, diagram, map),
TanStack Query, Fastify, Prisma, PostgreSQL, sharp.

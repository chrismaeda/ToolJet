# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a fork of ToolJet v2.67 (`chrismaeda/ToolJet`), an open-source low-code platform for building internal tools. The working branch is **`lts-v2.67`**; upstream `develop` is ToolJet 3.x and differs substantially, so don't assume 3.x code, docs or paths apply here.

The monorepo contains:
- **Frontend**: React 18 app builder (`frontend/`)
- **Server**: NestJS API with TypeORM (`server/`)
- **Plugins**: data source connectors, built as one Lerna package (`plugins/`)
- **Docs**: Docusaurus site (`docs/`), written for upstream

## Tech Stack

- **Node.js**: `.nvmrc` pins 24.16.0; `engines` allows `>=18.18.2` / npm `>=9.8.1`. `server/.npmrc` sets `engine-strict=true`.
- **Frontend**: React 18, Webpack 5, Bootstrap 5, Zustand 4, React Router 6, Yjs (multiplayer editing), react-dnd and @dnd-kit
- **Backend**: NestJS 10, TypeORM 0.3, CASL for permissions
- **Database**: PostgreSQL. Deployments use 16–18 (see `deploy/ec2/MANUAL_SETUP.md`); `docker-compose.yaml` still uses `postgres:13`.
- **Plugins**: Lerna 5, 45 packages in `plugins/packages/` (including `common`)

There is no BullMQ, Redis client or separate worker process on this branch.

## Monorepo Structure

```
/frontend/src
  /Editor            - App builder (canvas, inspector, query panel)
  /TooljetDatabase   - ToolJet Database UI (only used when ENABLE_TOOLJET_DB=true)
  /ManageSSO, /ManageOrgUsers, /ManageGroupPermissions(V2), ... - settings pages
  /_components       - Shared feature components
  /_ui               - Low-level UI components
  /_services         - API clients
  /_stores           - Zustand stores (appDataStore, editorStore, queryPanelStore,
                       currentStateStore, dataQueriesStore, ...)
  /modules           - auth, onboarding, common
/frontend/ee         - Enterprise-edition frontend code

/server
  /src
    /modules         - Feature modules, snake_case (apps, auth, data_sources,
                       data_queries, organizations, plugins, tooljet_db, ...)
    /controllers, /services, /repositories - Much logic still lives here,
                       outside /modules
    /entities        - TypeORM entities
    /dto             - DTOs with validation
    /migration-helpers - DataSource definitions for the migration CLI
    /mails           - Handlebars email templates
  /ce, /ee           - Community / Enterprise edition code (licensing, onboarding, ...)
  /migrations        - Schema migrations
  /data-migrations   - Data migrations
  ormconfig.ts, data-migration-config.ts - TypeORM configs
  /scripts           - create-database.ts, drop-database.ts, seeds.ts, boot scripts
  /test              - Unit/E2E tests

/plugins
  /packages          - One folder per connector (postgresql, restapi, s3, ...)
  create-client-entry.js, create-server-entry.js, create-operations-file.js
/marketplace         - Marketplace plugins
/deploy              - Docker, Helm, Kubernetes, EC2 (Packer + manual guide)
/cypress-tests       - Cypress E2E tests
```

## Development Commands

### Setup

```bash
nvm use                       # Node 24.16.0
npm install
cp .env.example .env          # then edit; the server reads .env (and .env.test) from the repo root
npm run build:plugins         # server imports @tooljet/plugins/dist/server, so build plugins first
npm run db:setup              # create DB + run schema and data migrations
npm run db:seed               # optional seed data
```

### Running

```bash
npm --prefix server start:dev     # API on :3000, hot reload
npm --prefix frontend start       # Webpack dev server on :8082
```

Or `docker-compose up` (client :8082, server :3000, PostgREST :3001, Postgres 13).

### Building and running in production

```bash
NODE_OPTIONS=--max-old-space-size=4096 npm run build   # plugins, frontend, server
npm run db:setup:prod                                  # or db:migrate:prod
npm run start:prod                                     # node server/dist/src/main
```

With `NODE_ENV=production` and `SERVE_CLIENT` not `false`, the server also serves `frontend/build` on :3000, so no separate web server is needed. Each `build:*` step prunes dev dependencies afterwards, so ts-node based scripts (`db:migrate`, `db:seed`) may stop working on a production build; use the `:prod` variants.

### Database

```bash
npm run db:create / db:migrate / db:seed / db:setup / db:reset / db:drop
npm run db:migrate:prod           # compiled JS from server/dist
```

- `db:migrate` runs schema migrations (`server/migrations`) then data migrations (`server/data-migrations`).
- Every run executes one `LockMigrationsTable…` migration on purpose (it locks the migrations table), so "1 new migration" on an up-to-date DB is normal.
- `PG_DB_OWNER=false` skips `createdb` and the `pgcrypto` extension migration; use it when the database is pre-created.
- The server only connects over SSL when given `DATABASE_URL`; the DB setup scripts ignore the port in `DATABASE_URL` (set `PG_PORT`).

### Testing and linting

```bash
npm --prefix server test          # Jest unit tests (*.spec.ts)
npm --prefix server test:e2e      # E2E tests in server/test (needs .env.test)
npm --prefix server test:cov
npm --prefix frontend test
npm --prefix plugins test
npm --prefix server lint / format
npm --prefix frontend lint / format
```

Husky runs lint-staged on commit (ESLint on staged frontend, server and plugin files).

## Architecture Notes

**Query execution**: frontend → `data_queries` controller → CASL permission check → `DataQueriesService` resolves data source options and credentials → calls the matching plugin from `@tooljet/plugins/dist/server` (`server/src/helpers/plugins.helper.ts`) → returns results.

**Plugins**: each package in `plugins/packages/<name>/` has `lib/index.ts` (QueryService), `lib/manifest.json` (connection options), `lib/operations.json` (query options), and tests in `__tests__/`. `npm run build:plugins` generates the client/server entry files and builds all packages; there is no `plugins:install` script on this branch. Scaffold new plugins with `npx @tooljet/cli plugin create`.

**ToolJet Database**: optional, controlled by `ENABLE_TOOLJET_DB`. When `false`, `TooljetDbModule` isn't loaded, PostgREST isn't needed, and TJDB-related data migrations return early. This fork's deployments run with it off.

**Credentials**: data source secrets are encrypted with `LOCKBOX_MASTER_KEY` (64 hex chars). Losing it makes stored credentials unrecoverable.

**Realtime**: WebSockets on `/ws` (events) and `/yjs` (multiplayer editing); any proxy must pass upgrades through.

## Deployment

`deploy/ec2/MANUAL_SETUP.md` is the maintained guide for this fork: Ubuntu VM, Node 24, external PostgreSQL (RDS) via `DATABASE_URL`, `ENABLE_TOOLJET_DB=false`, systemd unit `deploy/ec2/nest.service`, and TLS via an AWS load balancer, nginx or a Cloudflare Tunnel to `localhost:3000`. Keep it updated when setup steps change.

`deploy/ec2/setup_machine.sh` / `setup_app` are the older Packer/AMI flow (OpenResty, PostgREST) and aren't used for current deployments.

## Branching

- Work on `lts-v2.67`, which tracks `origin/lts-v2.67` on `chrismaeda/ToolJet`.
- Don't merge or rebase onto upstream `develop` (ToolJet 3.x); port specific fixes instead.

## Key Environment Variables

See `.env.example` and `deploy/ec2/MANUAL_SETUP.md`:
- `TOOLJET_HOST` – public URL; also used for SSO redirect URLs
- `DATABASE_URL` or `PG_HOST`/`PG_PORT`/`PG_USER`/`PG_PASS`/`PG_DB`
- `PG_DB_OWNER` – `false` for a pre-created database
- `LOCKBOX_MASTER_KEY`, `SECRET_KEY_BASE`
- `SERVE_CLIENT`, `NODE_ENV`, `PORT`
- `ENABLE_TOOLJET_DB`, `TOOLJET_DB_*`, `PGRST_*`

## License

AGPL v3.

# Deployment

**Merge to `main`. That is the whole process.** Within about two minutes the
VPS notices, builds, deploys and restarts itself. There is nothing to click and
nothing to configure.

## How it works

The server **pulls**; GitHub does not push.

```
merge to main
      |
      v
cron on the VPS (every 2 min)  ->  .github/scripts/vps-auto-deploy.sh
      |
      +-- origin/main unchanged?  exit silently
      |
      +-- changed:  build -> verify -> sync -> restart -> confirm healthy
```

A GitHub Actions job deploying *into* the server would need an SSH private key
stored as a repo secret. The repo is public and the VPS can already fetch it
over plain HTTPS, so turning the direction around removes the credential
entirely — nothing to create, paste, rotate, or leak.

## What runs where

| Where | What | Needs secrets |
|---|---|---|
| GitHub Actions (`ci.yml`) | lint, build, backend smoke test on every branch and PR | no |
| VPS cron (`vps-auto-deploy.sh`) | build, deploy, restart, health check | no |

CI is the gate *before* merge; the cron job is what happens *after*. They run
the same checks, so a branch that is green in CI is one the server will accept.

## Safety properties

These are deliberate, and each exists because of a specific failure:

- **A broken commit cannot take the site down.** Everything is built in a
  separate checkout (`~/deploy/repo`). Nothing is copied into the live app
  until the build, the localhost-bundle guard and the backend smoke test have
  all passed. The running version keeps serving.
- **A failed deploy retries.** The "already deployed" marker
  (`~/deploy/deployed.sha`) is written only after a *verified* restart, so a
  failure is picked up again on the next tick rather than skipped forever.
- **A repeatedly failing commit backs off** after three attempts instead of
  rebuilding every two minutes indefinitely. Push a new commit to clear it.
- **The restart is verified, not assumed.** Node reads its source once at
  startup, so copying files changes nothing until the process is replaced.
  Production once served a nine-day-old process for exactly that reason. The
  deploy fails if the service does not come back with a new PID and a healthy
  `/api/health`.
- **Only one deploy at a time**, enforced with `flock`.
- **Ten backups are kept** in `~/backups/`, one per deploy.

## Environment variables are NOT deployed

`backend/.env` and the root-owned `/etc/lease-management/lease-management.env`
already live on the server, outside the synced paths, and are never touched.
Only `backend/src/` and `frontend/dist/` are replaced.

To change an environment variable, edit it on the server and restart:

```bash
bash ~/deploy/repo/.github/scripts/restart-backend.sh
```

## Server layout

| Path | Purpose |
|---|---|
| `~/app` | the live application (systemd unit `lease-management`, port 5300) |
| `~/deploy/repo` | git checkout used for building — never served |
| `~/deploy/deployed.sha` | commit currently deployed |
| `~/deploy/deploy.log` | what happened, and why if it failed |
| `~/backups/` | last ten pre-deploy snapshots |

## Checking on it

```bash
# what is live right now
curl -s https://lease.crystalgrp.xyz/api/health

# recent deploys
ssh lease-management@<host> 'tail -30 ~/deploy/deploy.log'
```

`startedAt` in the health response is the reliable signal: if it is older than
your last merge, the restart did not take.

## Deploying by hand

Normally unnecessary, but the same script is safe to run directly:

```bash
ssh lease-management@<host> 'bash ~/deploy/auto-deploy.sh'
```

To force a redeploy of the current `main`:

```bash
ssh lease-management@<host> 'rm -f ~/deploy/deployed.sha && bash ~/deploy/auto-deploy.sh'
```

## Rolling back

Point the checkout at a known-good commit and let it deploy:

```bash
ssh lease-management@<host>
cd ~/deploy/repo && git reset --hard <good-sha>
rm -f ~/deploy/deployed.sha
# Then either restore the previous files directly:
tar xzf ~/backups/pre-deploy-<timestamp>.tar.gz -C ~/app
bash ~/deploy/repo/.github/scripts/restart-backend.sh
```

Note that cron will re-deploy `origin/main` on its next tick, so a rollback is
only durable once the bad commit is reverted on `main`.

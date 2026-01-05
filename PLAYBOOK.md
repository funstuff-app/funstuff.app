# MobileAir Playbook

This is the general engineering playbook for working in the MobileAir repo: where code lives, how to make changes safely, how to test/build/deploy, and the guardrails that prevent regressions.

For session-by-session notes and incident writeups, use `HISTORY.md`.

## Repo Map (Where Things Live)

- Core pure logic (testable): `mobileair/`
- Legacy core (kept for compatibility/tests): `mobileair_core.py`
- TUI entrypoint: `mobile_air.py`
- Dashboard server + state machine: `dashboard_server.py`
- Dashboard client (vanilla JS/CSS): `dashboard/`
- JS unit tests: `dashboard/tests/*.cjs`
- Python unit tests: `tests/test_*.py`
- PyInstaller bundle config: `mobileair.spec`

## Contracts (Don’t Break)

- `/api/state` JSON shape is the contract between server and dashboard.
- Server-authoritative meta fields (examples):
  - `meta.trail_update_start_ms`
  - `meta.trail_update_end_ms`
  - `meta.force_refresh_seq`

If you must change the JSON contract, update both:
- Server normalization (typically `mobileair/dashboard.py` and/or `dashboard_server.py`)
- Client consumption in `dashboard/app.js`
- Relevant tests.

## Change Workflow (Recommended)

1) Locate the source of truth
- UI behavior: `dashboard/app.js` (or TUI files).
- State/merging: `dashboard_server.py`.
- Pure algorithms: prefer adding/refactoring into `mobileair/`.

2) Implement the smallest correct change
- Keep UI concerns in the client.
- Keep pure logic testable (small helper modules where practical).

3) Add/adjust tests
- If it’s JS math/logic, prefer Node tests under `dashboard/tests/`.
- If it’s server behavior, prefer Python unit tests under `tests/`.

4) Run the full test suite
- Use `run_tests.py` as the default pre-ship check.

5) Build and verify packaged assets
- If you touched the dashboard static files, ensure PyInstaller bundles them.

6) Deploy safely
- Never delete the deploy target directory as part of normal deploy.

## Tests

### Python

```bash
/Users/johusha/Stuff/mobileair/.venv/bin/python -m unittest discover -s tests -p "test_*.py"
```

### Dashboard JS

```bash
node --check dashboard/app.js
node --test dashboard/tests/*.cjs
```

### Everything

```bash
/Users/johusha/Stuff/mobileair/.venv/bin/python run_tests.py
```

## Build (PyInstaller)

```bash
cd /Users/johusha/Stuff/mobileair
rm -rf build/mobileair dist/mobileair
/Users/johusha/Stuff/mobileair/.venv/bin/python -m PyInstaller --noconfirm --clean mobileair.spec
```

If you see a PyInstaller runtime error like `ArchiveReadError: Python magic pattern mismatch`, it usually indicates a stale/partial rebuild; do the clean rebuild above.

### Bundling Rule (Dashboard)

If you add any new file under `dashboard/` that must ship in the binary, you must also add it to `mobileair.spec` under `datas=[...]`.

Sanity check the bundled assets:

```bash
ls -la dist/mobileair/_internal/dashboard
```

## Deploy (Non-Destructive)

Do not delete the deploy target directory.

```bash
./deploy_local_safe.sh
```

Verify deployed assets:

```bash
ls -la ~/.local/mobileair/_internal/dashboard
```

## Verify / Troubleshoot Build & Deploy

Smoke-test the newly built binary before deploying:

```bash
./dist/mobileair/mobileair --help
```

Confirm the deployed binary matches the built artifact (useful when diagnosing “works in dist/ but not in /opt/”):

```bash
shasum -a 256 dist/mobileair/mobileair
shasum -a 256 ~/.local/mobileair/mobileair
```

Confirm what `mobileair` you are actually running (common when `/usr/local/bin/mobileair` is a symlink):

```bash
command -v mobileair
which -a mobileair
ls -la /usr/local/bin/mobileair
```

## Debug/Validation Checklist (Generic)

- Confirm tests pass (`run_tests.py`).
- Confirm the UI you changed no longer regresses (manual smoke test).
- Confirm packaging includes new static assets (if any).
- Confirm deploy did not delete the deploy target directory.

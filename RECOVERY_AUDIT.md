# Post-Git-Recovery Audit Prompt

## Context

On Feb 23 2026 a git disaster occurred: two diverged lineages of `main` (one containing commits from Jan 28–Feb 9, the other from Feb 10–Feb 22) were reconciled using `filter-branch --all` to rewrite author info, followed by multiple force-pushes. A bad squash commit temporarily deleted landing page files and dashboard JS modules. Everything has been restored but needs verification.

## Instructions

**DO NOT MAKE ANY CHANGES. READ-ONLY AUDIT ONLY.**

Run through each section below, report findings, and flag any discrepancies.

---

### 1. Git Integrity

- Run `git fsck --full` — report any dangling/broken objects
- Confirm `git log --all --format="%an <%ae>" | sort -u` shows ONLY `dj-3000 <chap.omelet_6i@icloud.com>`
- Confirm `git branch -a` shows `main`, `beta`, `remotes/origin/main`, `remotes/origin/beta`
- Confirm `main` and `beta` point at the same commit (`c25293f` or its equivalent)
- Confirm tags exist: `genesis`, `1.1-beta`, `mono`, `homepage`
- Confirm all 99 commits are present: `git log --oneline | wc -l`
- Confirm the old main lineage tip `c9f1ad5` is an ancestor of HEAD: `git merge-base --is-ancestor c9f1ad5 HEAD`

### 2. Local ↔ Remote Sync

- `git diff main origin/main` should be empty
- `git diff beta origin/beta` should be empty
- Check for uncommitted changes: `git status`
- List untracked files that SHOULD be committed (deploy scripts, .example files, landing files)

### 3. Landing Page Files

Verify local matches Pi (`jpark@192.168.10.148`):

```bash
# Compare file lists (exclude mp3s)
diff <(ssh jpark@192.168.10.148 "ls /home/jpark/funstuff/landing/ | grep -v mp3s" | sort) \
     <(ls landing/ | grep -v mp3s | sort)

# Compare checksums
ssh jpark@192.168.10.148 "md5sum /home/jpark/funstuff/landing/*.js /home/jpark/funstuff/landing/*.html /home/jpark/funstuff/landing/*.css /home/jpark/funstuff/landing/*.json"
md5 -r landing/*.js landing/*.html landing/*.css landing/*.json
```

Expected files: `flowerbox.js`, `fun.js`, `pipes.js`, `index.html`, `manifest.json`, `robots.txt`, `sitemap.xml`, `style.css`

Also verify `landing_server.py` matches:
```bash
ssh jpark@192.168.10.148 "md5sum /home/jpark/funstuff/landing_server.py"
md5 -r landing_server.py
```

### 4. Dashboard Files

Verify `dashboard/app.js` exists locally (the consolidated monolith). The Pi still has the OLD modular files (`aqi.js`, `colors.js`, `config.js`, `data_utils.js`, `format_utils.js`, `map_view.js`, `projections.js`, `sidebar_ui.js`). This is expected — the next deploy will replace them. Just verify `dashboard/app.js` contains the consolidated code (should be large, 2000+ lines).

### 5. Deploy Scripts

Verify these files exist locally and are executable where needed:

```
deploy/dustytrails/deploy_to_pi.sh        (executable)
deploy/dustytrails/dustytrails.service
deploy/dustytrails/README.md
deploy/dustytrails/caddy-snippet.txt
deploy/dustytrails/deploy.config           (gitignored — has real values)
deploy/dustytrails/deploy.config.example   (tracked — template)

deploy/landing/deploy_landing.sh           (executable)
deploy/landing/setup_tunnel.sh             (executable)
deploy/landing/funstuff-landing.service
deploy/landing/deploy.config               (gitignored)
deploy/landing/deploy.config.example       (tracked)
deploy/landing/tunnel.config               (gitignored)
deploy/landing/tunnel.config.example       (tracked)
```

Verify deploy scripts do NOT contain:
- Hardcoded IP addresses (should use `$PI_HOST` from config)
- Hardcoded usernames (should use `$PI_USER` from config)
- Hardcoded API keys or tokens
- Hardcoded domain names like `funstuff.app` (except in comments/docs)

Verify the dustytrails service template injects API key:
```bash
grep "DUSTY_PURPLEAIR_API_KEY" deploy/dustytrails/deploy_to_pi.sh
```

### 6. .gitignore

Verify `.gitignore` does NOT contain a blanket `deploy/` ignore. It should have specific ignores:
```
deploy/*/.staging/
deploy/*/.minify_cache/
deploy/*/deploy.config
deploy/*/tunnel.config
```

### 7. Pi Services Health

```bash
ssh jpark@192.168.10.148 "systemctl is-active dustytrails && systemctl is-active funstuff-landing && systemctl is-active cloudflared"
```

All three should report `active`.

### 8. Python / Tests

```bash
python -m pytest tests/ -x -q
```

Verify tests pass. If any fail, report which ones and the error — do NOT fix them.

---

## Summary Template

After running all checks, fill in:

| Check | Status | Notes |
|-------|--------|-------|
| Git integrity | | |
| Author identity | | |
| Local ↔ Remote sync | | |
| Landing files match Pi | | |
| Dashboard app.js present | | |
| Deploy scripts present | | |
| No hardcoded secrets | | |
| .gitignore correct | | |
| Pi services running | | |
| Tests passing | | |

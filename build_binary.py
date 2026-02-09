#!/usr/bin/env python3
"""
Build script for MobileAir native macOS binary.

Usage:
    python build_binary.py           # incremental (only rebuild if sources changed)
    python build_binary.py --clean   # force full clean rebuild
    python build_binary.py --force   # rebuild even if manifest says unchanged

This will:
1. Install PyInstaller if not present
2. Hash all source files and compare against the last build manifest
3. Skip the build if nothing changed (unless --clean or --force)
4. Build the native binary using the spec file
5. Output the binary to dist/mobileair_bundle
"""

import argparse
import hashlib
import json
import subprocess
import sys
import os
from pathlib import Path

# Files/directories that are inputs to the PyInstaller build.
# If any of these change, we need to rebuild.
SOURCE_GLOBS = [
    "mobile_air.py",
    "dashboard_server.py",
    "mobileair_core.py",
    "airnow_slc.py",
    "airnow_api.py",
    "aqi_breakpoints.csv",
    "mobileair.spec",
    "requirements.txt",
    "mobileair/**/*.py",
    "dashboard/*.js",
    "dashboard/*.css",
    "dashboard/*.html",
    "dashboard/*.json",
    "dashboard/*.png",
    "dashboard/*.svg",
]

MANIFEST_PATH = Path("build/mobileair_bundle/.build_manifest.json")


def _hash_file(path: Path) -> str:
    """Return hex SHA-256 of a file (fast, streaming read)."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _collect_source_hashes(root: Path) -> dict[str, str]:
    """Gather {relative_path: sha256} for every source file matching SOURCE_GLOBS."""
    hashes: dict[str, str] = {}
    for pattern in SOURCE_GLOBS:
        for p in sorted(root.glob(pattern)):
            if p.is_file():
                rel = str(p.relative_to(root))
                hashes[rel] = _hash_file(p)
    return hashes


def _load_manifest(root: Path) -> dict | None:
    manifest = root / MANIFEST_PATH
    if manifest.exists():
        try:
            return json.loads(manifest.read_text())
        except (json.JSONDecodeError, OSError):
            return None
    return None


def _save_manifest(root: Path, hashes: dict[str, str]) -> None:
    manifest = root / MANIFEST_PATH
    manifest.parent.mkdir(parents=True, exist_ok=True)
    manifest.write_text(json.dumps(hashes, indent=2, sort_keys=True) + "\n")


def _diff_hashes(
    old: dict[str, str], new: dict[str, str]
) -> tuple[list[str], list[str], list[str]]:
    """Return (added, removed, modified) file lists."""
    old_keys, new_keys = set(old), set(new)
    added = sorted(new_keys - old_keys)
    removed = sorted(old_keys - new_keys)
    modified = sorted(k for k in old_keys & new_keys if old[k] != new[k])
    return added, removed, modified


def main():
    parser = argparse.ArgumentParser(description="Build MobileAir native macOS binary")
    parser.add_argument(
        "--clean", action="store_true",
        help="Force a full clean rebuild (wipe PyInstaller cache)",
    )
    parser.add_argument(
        "--force", action="store_true",
        help="Rebuild even if source hashes are unchanged",
    )
    args = parser.parse_args()

    script_dir = Path(__file__).parent.resolve()
    os.chdir(script_dir)

    print("=" * 60)
    print("MobileAir Native Binary Builder")
    print("=" * 60)

    # ── Step 1: Check source changes ────────────────────────────
    current_hashes = _collect_source_hashes(script_dir)
    binary_path = script_dir / "dist" / "mobileair_bundle" / "mobileair"
    dist_dir = script_dir / "dist" / "mobileair_bundle"

    needs_build = True
    if not args.clean and not args.force:
        prev = _load_manifest(script_dir)
        if prev is not None and binary_path.exists():
            added, removed, modified = _diff_hashes(prev, current_hashes)
            if not added and not removed and not modified:
                needs_build = False
            else:
                changed = added + removed + modified
                print(f"\n  {len(changed)} file(s) changed since last build:")
                for f in changed[:15]:
                    tag = "+" if f in added else ("-" if f in removed else "~")
                    print(f"    {tag} {f}")
                if len(changed) > 15:
                    print(f"    ... and {len(changed) - 15} more")

    if not needs_build:
        total_size = sum(f.stat().st_size for f in dist_dir.rglob("*") if f.is_file())
        size_mb = total_size / (1024 * 1024)
        print("\n✅ No source changes detected — skipping build.")
        print(f"   Bundle: {dist_dir}  ({size_mb:.1f} MB)")
        print("   Use --force to rebuild anyway, or --clean for a full rebuild.")
        return

    # ── Step 2: Check/install PyInstaller ───────────────────────
    print("\n[1/3] Checking PyInstaller...")
    try:
        import PyInstaller
        print(f"      PyInstaller {PyInstaller.__version__} found")
    except ImportError:
        print("      Installing PyInstaller...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", "pyinstaller"])
        print("      PyInstaller installed")

    # ── Step 3: Ensure runtime dependencies ─────────────────────
    print("\n[2/3] Checking dependencies...")
    subprocess.check_call(
        [sys.executable, "-m", "pip", "install", "-r", "requirements.txt", "-q"]
    )
    print("      Dependencies OK")

    # ── Step 4: Build ───────────────────────────────────────────
    label = "full clean rebuild" if args.clean else "incremental rebuild"
    print(f"\n[3/3] Building native binary ({label})...")
    print("      This may take a minute...")

    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm",
        "--workpath", "build/mobileair_bundle",
        "mobileair.spec",
    ]
    if args.clean:
        cmd.insert(3, "--clean")

    result = subprocess.run(cmd, capture_output=False)

    if result.returncode != 0:
        print("\n❌ Build failed!")
        sys.exit(1)

    if binary_path.exists():
        # Save manifest so next run can skip if nothing changed
        _save_manifest(script_dir, current_hashes)

        total_size = sum(f.stat().st_size for f in dist_dir.rglob("*") if f.is_file())
        size_mb = total_size / (1024 * 1024)
        print("\n" + "=" * 60)
        print("✅ Build successful!")
        print("=" * 60)
        print(f"\nBinary: {binary_path}")
        print(f"Bundle: {dist_dir}")
        print(f"Size:   {size_mb:.1f} MB")
        print("\nRun with:")
        print(f"  {binary_path}")
        print("\nTo install (user-local, no /opt required):")
        print("  ./deploy_local_safe.sh")
    else:
        print("\n❌ Binary not found at expected location")
        sys.exit(1)


if __name__ == "__main__":
    main()

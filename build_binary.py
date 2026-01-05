#!/usr/bin/env python3
"""
Build script for MobileAir native macOS binary.

Usage:
    python build_binary.py

This will:
1. Install PyInstaller if not present
2. Build the native binary using the spec file
3. Output the binary to dist/mobileair_bundle
"""

import subprocess
import sys
import os
from pathlib import Path


def main():
    script_dir = Path(__file__).parent.resolve()
    os.chdir(script_dir)
    
    print("=" * 60)
    print("MobileAir Native Binary Builder")
    print("=" * 60)
    
    # Check/install PyInstaller
    print("\n[1/3] Checking PyInstaller...")
    try:
        import PyInstaller
        print(f"      PyInstaller {PyInstaller.__version__} found")
    except ImportError:
        print("      Installing PyInstaller...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", "pyinstaller"])
        print("      PyInstaller installed")
    
    # Ensure all runtime dependencies are installed
    print("\n[2/3] Checking dependencies...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-r", "requirements.txt", "-q"])
    print("      Dependencies OK")
    
    # Build the binary
    print("\n[3/3] Building native binary...")
    print("      This may take a minute...")
    
    result = subprocess.run(
        [
            sys.executable, "-m", "PyInstaller",
            "--clean",
            "--noconfirm",
            "--workpath", "build/mobileair_bundle",
            "mobileair.spec"
        ],
        capture_output=False
    )
    
    if result.returncode != 0:
        print("\n❌ Build failed!")
        sys.exit(1)
    
    # Directory mode creates dist/mobileair_bundle/mobileair
    binary_path = script_dir / "dist" / "mobileair_bundle" / "mobileair"
    dist_dir = script_dir / "dist" / "mobileair_bundle"
    
    if binary_path.exists():
        # Calculate total size of dist directory
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

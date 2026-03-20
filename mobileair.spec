# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec file for MobileAir native macOS binary.

This bundles:
- mobile_air.py (TUI entry point)
- dashboard_server.py (HTTP server)
- mobileair/ package (core logic)
- dashboard/ folder (browser UI static files)
- airnow_slc.py, airnow_api.py (data fetchers)
- aqi_breakpoints.csv (data file)
"""

import os
from pathlib import Path

import eccodeslib
import eckitlib

# Get certifi CA bundle path for SSL
try:
    import certifi
    CERTIFI_CA_BUNDLE = certifi.where()
except ImportError:
    CERTIFI_CA_BUNDLE = None

block_cipher = None

# Get the directory containing this spec file
spec_dir = os.path.dirname(os.path.abspath(SPEC))
_eccodeslib_dir = os.path.dirname(eccodeslib.__file__)
_eckitlib_dir = os.path.dirname(eckitlib.__file__)
_eccodeslib_lib_dir = os.path.join(_eccodeslib_dir, 'lib')

# Exclude heavy unnecessary dependencies
EXCLUDES = [
    # Data science / visualization (not needed)
    'matplotlib',
    'scipy',
    'PIL',
    'Pillow',
    'cv2',
    'sklearn',
    
    # Jupyter/IPython (not needed)
    'IPython',
    'ipython',
    'jupyter',
    'jupyter_client',
    'jupyter_core',
    'ipykernel',
    'notebook',
    'nbformat',
    'nbconvert',
    'ipywidgets',
    'traitlets',
    'zmq',
    'tornado',
    
    # Testing (not needed at runtime)
    'pytest',
    'py',
    '_pytest',
    'unittest',
    'doctest',
    
    # Qt/Tk GUI (not needed - we use terminal)
    'PyQt5',
    'PyQt6',
    'PySide2',
    'PySide6',
    'tkinter',
    '_tkinter',
    'Tkinter',
    'wx',
    
    # HTTP libs - requests needed for dirigera
    # 'requests',
    # 'urllib3',
    
    # Other unnecessary
    'setuptools',
    'pkg_resources',
    'wheel',
    'pip',
    'jedi',
    'parso',
    'pexpect',
    'ptyprocess',
    'pyzmq',
    'debugpy',
    'sqlite3',
    'xmlrpc',
]

a = Analysis(
    ['mobile_air.py'],
    pathex=[spec_dir],
    binaries=[
        *[(str(p), 'eccodeslib/lib') for p in Path(_eccodeslib_lib_dir).glob('*.dylib')],
    ],
    datas=[
        # Dashboard static files (browser UI) — glob all web assets so new
        # modules don't cause 404s after the app.js modularization.
        *[(str(p), 'dashboard') for p in Path(spec_dir, 'dashboard').glob('*.js')],
        *[(str(p), 'dashboard') for p in Path(spec_dir, 'dashboard').glob('*.css')],
        *[(str(p), 'dashboard') for p in Path(spec_dir, 'dashboard').glob('*.html')],
        *[(str(p), 'dashboard') for p in Path(spec_dir, 'dashboard').glob('*.json')],
        *[(str(p), 'dashboard') for p in Path(spec_dir, 'dashboard').glob('*.png')],
        *[(str(p), 'dashboard') for p in Path(spec_dir, 'dashboard').glob('*.svg')],
        # Data files
        ('aqi_breakpoints.csv', '.'),
        # Additional Python modules that need to be found
        ('dashboard_server.py', '.'),
        ('airnow_slc.py', '.'),
        ('airnow_api.py', '.'),
    ] + ([(CERTIFI_CA_BUNDLE, 'certifi')] if CERTIFI_CA_BUNDLE else [])
    + [
        # eccodeslib package data (native GRIB2 libraries)
        (_eccodeslib_dir, 'eccodeslib'),
        (_eckitlib_dir, 'eckitlib'),
    ],
    hiddenimports=[
        'certifi',
        'textual',
        'textual.app',
        'textual.widgets',
        'textual.containers',
        'textual.screen',
        'textual.reactive',
        'rich',
        'rich.panel',
        'rich.table',
        'rich.console',
        'rich.text',
        'rich.json',
        'rich.theme',
        'mobileair',
        'mobileair.aqi',
        'mobileair.config',
        'mobileair.dashboard',
        'mobileair.map_html',
        'mobileair.mobility',
        'mobileair.network',
        'mobileair.outliers',
        'mobileair.trails',
        'mobileair.tui_format',
        'mobileair.utils',
        'mobileair.wind',
        'mobileair.dirigera_home',
        'dirigera',
        'dirigera.hub',
        'pydantic',
        'websocket',
        'websocket._core',
        'dotenv',
        'requests',
        'urllib3',
        'xarray',
        'xarray.backends',
        'cfgrib',
        'cfgrib.xarray_store',
        'eccodes',
        'eccodeslib',
        'eckitlib',
        'findlibs',
        'numpy',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=EXCLUDES,
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=True,  # Don't compress bytecode - faster load
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

# Use COLLECT for directory mode (faster startup, no extraction needed)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='mobileair',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity='',  # Skip PyInstaller signing - we sign in deploy_local_safe.sh
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    name='mobileair_bundle',
)

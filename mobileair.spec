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

# Get certifi CA bundle path for SSL
try:
    import certifi
    CERTIFI_CA_BUNDLE = certifi.where()
except ImportError:
    CERTIFI_CA_BUNDLE = None

block_cipher = None

# Get the directory containing this spec file
spec_dir = os.path.dirname(os.path.abspath(SPEC))

# Exclude heavy unnecessary dependencies
EXCLUDES = [
    # Data science / visualization (not needed)
    'matplotlib',
    'numpy',
    'pandas',
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
    
    # HTTP libs we don't use anymore (using stdlib)
    'requests',
    'urllib3',
    
    # Other unnecessary
    'setuptools',
    'pkg_resources',
    'distutils',
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
    binaries=[],
    datas=[
        # Dashboard static files (browser UI)
        ('dashboard/index.html', 'dashboard'),
        ('dashboard/app.js', 'dashboard'),
        ('dashboard/camera_fit_logic.js', 'dashboard'),
        ('dashboard/map_nav_engine.js', 'dashboard'),
        ('dashboard/styles.css', 'dashboard'),
        ('dashboard/tui.html', 'dashboard'),
        ('dashboard/tui.css', 'dashboard'),
        ('dashboard/tui.js', 'dashboard'),
        # Data files
        ('aqi_breakpoints.csv', '.'),
        # Additional Python modules that need to be found
        ('dashboard_server.py', '.'),
        ('airnow_slc.py', '.'),
        ('airnow_api.py', '.'),
    ] + ([(CERTIFI_CA_BUNDLE, 'certifi')] if CERTIFI_CA_BUNDLE else []),
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
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    name='mobileair',
)

# -*- mode: python ; coding: utf-8 -*-

# PyInstaller spec for the unityide-graph sidecar binary.
#
# Build with:  pyinstaller pyinstaller.spec
# Produces:    dist/unityide-graph (or unityide-graph.exe on Windows)
#
# We exclude graphify's heavy optional deps (whisper, torch, yt_dlp) and keep
# only the languages tree-sitter parsers most likely to show up in real IDE
# workloads. The full tree-sitter-* set is large; trim to taste.

from PyInstaller.utils.hooks import collect_submodules, collect_dynamic_libs, collect_data_files

block_cipher = None

# Tree-sitter language packages that ship native .so/.dylib/.dll. Each one
# needs both its Python module AND its compiled native blob collected — that's
# what `collect_dynamic_libs` is for. List them explicitly so the bundle stays
# predictable across upstream changes.
TREE_SITTER_LANGUAGES = [
    'tree_sitter',
    'tree_sitter_typescript',
    'tree_sitter_javascript',
    'tree_sitter_python',
    'tree_sitter_rust',
    'tree_sitter_go',
    'tree_sitter_java',
    'tree_sitter_c',
    'tree_sitter_cpp',
    'tree_sitter_c_sharp',
    'tree_sitter_ruby',
    'tree_sitter_php',
    'tree_sitter_swift',
    'tree_sitter_kotlin',
    'tree_sitter_scala',
    'tree_sitter_lua',
]

hidden = [
    'graphify',
    'graphify.detect',
    'graphify.extract',
    'graphify.build',
    'graphify.cluster',
    'graphify.analyze',
    'graphify.export',
    'graphify.cache',
    'graphify.report',
    'networkx',
    'networkx.readwrite',
    'networkx.readwrite.json_graph',
]
for lang in TREE_SITTER_LANGUAGES:
    hidden.extend(collect_submodules(lang))

binaries = []
datas = []
for lang in TREE_SITTER_LANGUAGES:
    binaries.extend(collect_dynamic_libs(lang))
    datas.extend(collect_data_files(lang))

a = Analysis(
    ['unityide_graph.py'],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hidden,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'whisper',
        'openai_whisper',
        'torch',
        'torchvision',
        'torchaudio',
        'yt_dlp',
        'tiktoken',
        'numba',
        'tkinter',
        'matplotlib',
        'IPython',
        'jupyter',
        'notebook',
        'pytest',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='unityide-graph',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

# Build and development

Windows x64 prerequisites: Node.js 22+, Python 3.12, Rust stable, Microsoft C++ Build Tools and WebView2. End users do not need development tools.

```powershell
npm ci
py -3.12 -m venv .qa/desktop-build
.qa/desktop-build/Scripts/python.exe -m pip install -r desktop/backend/requirements-build-lock.txt
npm run build
npm test
.qa/desktop-build/Scripts/python.exe -m unittest discover -s desktop/tests -v
.qa/desktop-build/Scripts/python.exe scripts/build-desktop-core.py
npm run desktop:dev
```

`LISTEN_LOCAL_CORE_PYTHON` overrides the core interpreter for development. Normal development uses `.qa/desktop-build/Scripts/python.exe`; the production app uses its bundled executable. The application stores its settings in Tauri's per-user local application data directory. Select an existing model and runtime from the settings window, or use the released download packs.

## Installer

```powershell
.qa/desktop-build/Scripts/python.exe scripts/build-desktop-core.py
npm run desktop:build
```

The NSIS installer is under `src-tauri/target/release/bundle/nsis/`. `desktop/backend/resources/` contains pinned runtime/model manifests and is included in the core executable. The icons are original project graphics; `scripts/make-desktop-icons.py` regenerates them.

## Runtime packs

```powershell
.qa/desktop-build/Scripts/python.exe scripts/build-runtime.py --flavor cpu
.qa/desktop-build/Scripts/python.exe scripts/build-runtime.py --flavor cuda
```

Build the flavors sequentially, since each updates the shared runtime manifest. The official Python 3.12.10 embedded archive has a pinned SHA-256. Dependencies are pinned in the two runtime lock files. The `sox` Python wrapper is built from its pinned source package because its current release has no wheel; the external SoX program is not used by CustomVoice generation.

The optional `--reuse-environment` switch packages a previously validated environment for local verification. Release maintainers must verify the same locked package versions and ensure there are no editable installs, credentials or absolute local `.pth` paths. Models are separate and are never included in runtime archives.

`scripts/prepare-model-manifest.py <official-model-directory>` hashes files from the pinned official 0.6B revision. Use it only when deliberately rebuilding the manifest, not at application startup.

## Real inference validation

```powershell
.qa/desktop-build/Scripts/python.exe scripts/benchmark-desktop-engine.py --python <runtime-python.exe> --model <model-directory> --device gpu --repeats 20 --output .qa/gpu.json
.qa/desktop-build/Scripts/python.exe scripts/benchmark-desktop-engine.py --python <runtime-python.exe> --model <model-directory> --device cpu --threads 6 --repeats 1 --output .qa/cpu.json
```

Benchmarks write original PCM and measured records under the requested output directory. First-block latency is measured at the protocol receiver, not acoustic speaker output. UI playback, package installation and real mobile imports have separate acceptance records. CI runs deterministic unit/integration tests and builds the desktop installer; it does not claim GPU or phone validation.

## Contributions

Keep changes focused. Prefer a small function or module to a new framework. Test durable state transitions, protocol boundaries and format handling; do not add heavyweight runtime dependencies to the UI or core. Retain source notices and keep private books, model weights, binaries, environments and generated audio out of Git.

## Installed-package checks

`scripts/smoke-packaged-core.py --core <installed-listen-core.exe> --home <test-directory> --runtime <runtime-python.exe> --model <model-directory>` runs an actual two-chapter CPU job, export, download and clean shutdown with development Python removed from the child PATH.

`scripts/check-packaged-recovery.py` takes the same arguments. It requests shutdown during a real CPU job, restarts the core, resumes and verifies hashes of completed segments are unchanged. Always use an isolated test directory.

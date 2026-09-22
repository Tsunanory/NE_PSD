# Windows installation

The intended package is a per-user NSIS installer for Windows 11 x64 named `NE PSD.exe`. The package recipe retains jobs, evidence, templates and outputs outside application resources. Uninstall does not delete them; settings removal must be an explicit user choice.

The current runtime manifest is `blocked`. It records only exact foundation values: Node 22.23.2, Electron 41.0.0 and the observed Node Windows x64 checksum. Windows vendor archives, MCP production tree, native ABI proof, Photoshop and model evidence are not staged. Package preparation fails closed and never downloads resources or runs `npx`/`npm install`.

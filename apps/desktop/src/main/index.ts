import { app, BrowserWindow } from 'electron';
import { secureWebPreferences } from './window-config.js';
export function createMainWindow(): BrowserWindow { return new BrowserWindow({ webPreferences: secureWebPreferences }); }
if (app?.whenReady) app.whenReady().then(() => createMainWindow());

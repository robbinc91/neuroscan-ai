import { app, BrowserWindow, ipcMain, dialog, Menu, shell } from 'electron';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Store from 'electron-store';
import { readFile, writeFile } from 'fs/promises';

// ES module __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const store = new Store({
    encryptionKey: 'neuroscan-ai-encryption-key-v1' // In production, use a more secure key
});

let mainWindow: BrowserWindow | null = null;

// Environment check
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

function createWindow() {
    // Restore window state from store
    const windowState = store.get('windowState', {
        width: 1400,
        height: 900,
        x: undefined,
        y: undefined,
        maximized: false
    }) as { width: number; height: number; x?: number; y?: number; maximized: boolean };

    mainWindow = new BrowserWindow({
        width: windowState.width,
        height: windowState.height,
        x: windowState.x,
        y: windowState.y,
        minWidth: 1024,
        minHeight: 768,
        backgroundColor: '#0d1117',
        title: 'NeuroScan AI',
        webPreferences: {
            preload: join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            webSecurity: true
        },
        show: false, // Don't show until ready
        icon: join(__dirname, '../assets/icon.png') // Add app icon
    });

    // Restore maximized state
    if (windowState.maximized) {
        mainWindow.maximize();
    }

    // Save window state on close
    mainWindow.on('close', () => {
        if (!mainWindow) return;

        const bounds = mainWindow.getBounds();
        store.set('windowState', {
            width: bounds.width,
            height: bounds.height,
            x: bounds.x,
            y: bounds.y,
            maximized: mainWindow.isMaximized()
        });
    });

    // Load the app
    if (isDev) {
        mainWindow.loadURL('http://localhost:5173'); // Vite dev server
        mainWindow.webContents.openDevTools();
    } else {
        mainWindow.loadFile(join(__dirname, '../dist/index.html'));
    }

    // Show window when ready
    mainWindow.once('ready-to-show', () => {
        mainWindow?.show();
    });

    // Handle external links
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });

    // Create application menu
    createMenu();
}

function createMenu() {
    const template: Electron.MenuItemConstructorOptions[] = [
        {
            label: 'File',
            submenu: [
                {
                    label: 'Import Scan...',
                    accelerator: 'CmdOrCtrl+O',
                    click: () => {
                        mainWindow?.webContents.send('menu-import-scan');
                    }
                },
                {
                    label: 'Import Segmentation...',
                    accelerator: 'CmdOrCtrl+Shift+O',
                    click: () => {
                        mainWindow?.webContents.send('menu-import-segmentation');
                    }
                },
                { type: 'separator' },
                {
                    label: 'Export Report...',
                    accelerator: 'CmdOrCtrl+E',
                    click: () => {
                        mainWindow?.webContents.send('menu-export-report');
                    }
                },
                { type: 'separator' },
                {
                    label: 'Settings',
                    accelerator: 'CmdOrCtrl+,',
                    click: () => {
                        mainWindow?.webContents.send('menu-open-settings');
                    }
                },
                { type: 'separator' },
                { role: 'quit' }
            ]
        },
        {
            label: 'Edit',
            submenu: [
                { role: 'undo' },
                { role: 'redo' },
                { type: 'separator' },
                { role: 'cut' },
                { role: 'copy' },
                { role: 'paste' }
            ]
        },
        {
            label: 'View',
            submenu: [
                { role: 'reload' },
                { role: 'forceReload' },
                { role: 'toggleDevTools' },
                { type: 'separator' },
                { role: 'resetZoom' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { type: 'separator' },
                { role: 'togglefullscreen' }
            ]
        },
        {
            label: 'Window',
            submenu: [
                { role: 'minimize' },
                { role: 'zoom' },
                { role: 'close' }
            ]
        },
        {
            label: 'Help',
            submenu: [
                {
                    label: 'Documentation',
                    click: () => {
                        shell.openExternal('https://github.com/yourusername/neuroscan-ai');
                    }
                },
                {
                    label: 'Report Issue',
                    click: () => {
                        shell.openExternal('https://github.com/yourusername/neuroscan-ai/issues');
                    }
                }
            ]
        }
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}

// IPC Handlers

// File Dialog - Open files (NIfTI/DICOM)
ipcMain.handle('dialog:openFile', async (_, options?: {
    filters?: Electron.FileFilter[],
    properties?: ('openFile' | 'multiSelections')[]
}) => {
    if (!mainWindow) return null;

    const defaultFilters = [
        { name: 'Medical Images', extensions: ['nii', 'nii.gz', 'dcm', 'ima'] },
        { name: 'NIfTI Files', extensions: ['nii', 'nii.gz'] },
        { name: 'DICOM Files', extensions: ['dcm', 'ima'] },
        { name: 'All Files', extensions: ['*'] }
    ];

    const result = await dialog.showOpenDialog(mainWindow, {
        properties: options?.properties || ['openFile', 'multiSelections'],
        filters: options?.filters || defaultFilters
    });

    if (result.canceled) return null;

    // Read file(s) and return as ArrayBuffer
    const files = await Promise.all(
        result.filePaths.map(async (filePath) => {
            const buffer = await readFile(filePath);
            return {
                name: filePath.split(/[\\/]/).pop() || 'unknown',
                path: filePath,
                data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
            };
        })
    );

    return files;
});

// File Dialog - Save file
ipcMain.handle('dialog:saveFile', async (_, data: ArrayBuffer, defaultName: string, filters?: Electron.FileFilter[]) => {
    if (!mainWindow) return null;

    const result = await dialog.showSaveDialog(mainWindow, {
        defaultPath: defaultName,
        filters: filters || [
            { name: 'PDF Files', extensions: ['pdf'] },
            { name: 'All Files', extensions: ['*'] }
        ]
    });

    if (result.canceled || !result.filePath) return null;

    try {
        await writeFile(result.filePath, Buffer.from(data));
        return result.filePath;
    } catch (error) {
        console.error('Error saving file:', error);
        return null;
    }
});

// Store - Get setting
ipcMain.handle('store:get', (_, key: string) => {
    return store.get(key);
});

// Store - Set setting
ipcMain.handle('store:set', (_, key: string, value: any) => {
    store.set(key, value);
    return true;
});

// Store - Delete setting
ipcMain.handle('store:delete', (_, key: string) => {
    store.delete(key);
    return true;
});

// Get app path
ipcMain.handle('app:getPath', (_, name: 'home' | 'appData' | 'userData' | 'temp' | 'downloads') => {
    return app.getPath(name);
});

// Get app version
ipcMain.handle('app:getVersion', () => {
    return app.getVersion();
});

// App lifecycle
app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// Handle file associations (when app is already running)
app.on('open-file', async (event, path) => {
    event.preventDefault();

    if (mainWindow) {
        const buffer = await readFile(path);
        mainWindow.webContents.send('file-opened', {
            name: path.split(/[\\/]/).pop() || 'unknown',
            path: path,
            data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
        });
    }
});

import { app, BrowserWindow, ipcMain, dialog, Menu, shell } from 'electron';
import { join, dirname, basename, extname } from 'path';
import { fileURLToPath } from 'url';
import Store from 'electron-store';
import { mkdir, readFile, writeFile, readdir, open } from 'fs/promises';

// ES module __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const store = new Store({
    encryptionKey: 'neuroscan-ai-encryption-key-v1' // In production, use a more secure key
});

let mainWindow: BrowserWindow | null = null;

type OpenedFilePayload = { name: string; path: string; data: ArrayBuffer };

let pendingOpenFile: OpenedFilePayload | null = null;
let rendererReady = false;
let queuedOpenPath: string | null = null;

function isMedicalImagePath(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return (
        lower.endsWith('.nii') ||
        lower.endsWith('.nii.gz') ||
        lower.endsWith('.dcm') ||
        lower.endsWith('.ima') ||
        lower.endsWith('.dicom')
    );
}

function filePathFromArgv(argv: string[]): string | undefined {
    for (const arg of argv) {
        if (!arg || arg.startsWith('-')) continue;
        if (arg === '.') continue;
        if (/\.(exe|app|asar)$/i.test(arg)) continue;
        if (arg.toLowerCase().includes('electron')) continue;
        if (isMedicalImagePath(arg)) return arg;
    }
    return undefined;
}

async function readOpenedFile(filePath: string): Promise<OpenedFilePayload> {
    const buffer = await readFile(filePath);
    return {
        name: filePath.split(/[\\/]/).pop() || 'unknown',
        path: filePath,
        data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    };
}

function deliverOpenedFile(payload: OpenedFilePayload) {
    pendingOpenFile = payload;
    if (mainWindow && !mainWindow.isDestroyed() && rendererReady) {
        mainWindow.webContents.send('file-opened', payload);
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    }
}

async function openAssociatedPath(filePath: string) {
    try {
        deliverOpenedFile(await readOpenedFile(filePath));
    } catch (error) {
        console.error('Failed to open associated file:', error);
        dialog.showErrorBox(
            'NeuroScan AI',
            `Could not open file:\n${filePath}\n\n${error instanceof Error ? error.message : String(error)}`
        );
    }
}

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

    mainWindow.webContents.on('did-start-loading', () => {
        rendererReady = false;
    });
    mainWindow.webContents.on('did-finish-load', () => {
        rendererReady = true;
        if (pendingOpenFile) {
            mainWindow?.webContents.send('file-opened', pendingOpenFile);
        }
    });

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
                    label: 'Import Folder / DICOMDIR...',
                    accelerator: 'CmdOrCtrl+Shift+F',
                    click: () => {
                        mainWindow?.webContents.send('menu-import-folder');
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
                {
                    label: 'Export Volume...',
                    accelerator: 'CmdOrCtrl+Shift+S',
                    click: () => {
                        mainWindow?.webContents.send('menu-export-volume');
                    }
                },
                {
                    label: 'Export Segmentation...',
                    accelerator: 'CmdOrCtrl+Shift+G',
                    click: () => {
                        mainWindow?.webContents.send('menu-export-segmentation');
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
                {
                    label: 'Undo',
                    accelerator: 'CmdOrCtrl+Z',
                    registerAccelerator: false,
                    click: () => {
                        mainWindow?.webContents.send('menu-undo');
                    }
                },
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
                {
                    label: 'Layout',
                    submenu: [
                        {
                            label: 'Four-Up',
                            click: () => mainWindow?.webContents.send('menu-set-view-mode', 'FOUR_UP')
                        },
                        {
                            label: 'Axial',
                            click: () => mainWindow?.webContents.send('menu-set-view-mode', 'AXIAL')
                        },
                        {
                            label: 'Sagittal',
                            click: () => mainWindow?.webContents.send('menu-set-view-mode', 'SAGITTAL')
                        },
                        {
                            label: 'Coronal',
                            click: () => mainWindow?.webContents.send('menu-set-view-mode', 'CORONAL')
                        },
                        {
                            label: '3D',
                            click: () => mainWindow?.webContents.send('menu-set-view-mode', '3D')
                        }
                    ]
                },
                { type: 'separator' },
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
                        shell.openExternal('https://github.com/robbinc91/neuroscan-ai');
                    }
                },
                {
                    label: 'Report Issue',
                    click: () => {
                        shell.openExternal('https://github.com/robbinc91/neuroscan-ai/issues');
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
    properties?: ('openFile' | 'multiSelections' | 'openDirectory' | 'createDirectory')[]
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

async function looksLikeDicom(filePath: string): Promise<boolean> {
    const name = basename(filePath).toLowerCase();
    if (name === 'dicomdir' || name.endsWith('.dcm') || name.endsWith('.ima') || name.endsWith('.dicom')) return true;
    const ext = extname(name);
    if (ext && ext !== '.') return false;
    try {
        const fh = await open(filePath, 'r');
        const buf = Buffer.alloc(132);
        const { bytesRead } = await fh.read(buf, 0, 132, 0);
        await fh.close();
        if (bytesRead < 132) return false;
        return buf.slice(128, 132).toString('ascii') === 'DICM';
    } catch {
        return false;
    }
}

async function walkMedicalFiles(root: string, out: string[], depth = 0): Promise<void> {
    if (depth > 8 || out.length > 8000) return;
    let entries;
    try {
        entries = await readdir(root, { withFileTypes: true });
    } catch {
        return;
    }
    for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const p = join(root, e.name);
        if (e.isDirectory()) {
            if (e.name === 'node_modules') continue;
            await walkMedicalFiles(p, out, depth + 1);
            continue;
        }
        const n = e.name.toLowerCase();
        if (n.endsWith('.nii') || n.endsWith('.nii.gz') || n.endsWith('.hdr') || n.endsWith('.gz')) {
            out.push(p);
            continue;
        }
        if (await looksLikeDicom(p)) out.push(p);
    }
}

ipcMain.handle('fs:readMedicalFolder', async (_, dirPath?: string) => {
    if (!mainWindow) return null;
    let root = dirPath;
    if (!root) {
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openDirectory']
        });
        if (result.canceled || result.filePaths.length === 0) return null;
        root = result.filePaths[0];
    }
    const paths: string[] = [];
    await walkMedicalFiles(root, paths);
    const files = await Promise.all(
        paths.map(async (filePath) => {
            const buffer = await readFile(filePath);
            return {
                name: filePath.split(/[\\/]/).pop() || 'unknown',
                path: filePath,
                data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
            };
        })
    );
    return { root, files };
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

// File Dialog - Select output directory
ipcMain.handle('dialog:selectDirectory', async () => {
    if (!mainWindow) return null;

    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory', 'createDirectory']
    });

    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
});

// Write multiple text/base64 files to a directory
ipcMain.handle('fs:writeBundle', async (_, directoryPath: string, files: Array<{
    relativePath: string;
    content: string;
    encoding?: 'utf8' | 'base64';
}>) => {
    try {
        await mkdir(directoryPath, { recursive: true });

        for (const file of files) {
            const fullPath = join(directoryPath, file.relativePath);
            const parent = dirname(fullPath);
            await mkdir(parent, { recursive: true });
            await writeFile(fullPath, file.content, {
                encoding: file.encoding || 'utf8'
            });
        }

        return true;
    } catch (error) {
        console.error('Error writing bundle:', error);
        return false;
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

ipcMain.handle('app:takePendingOpenFile', () => {
    const file = pendingOpenFile;
    pendingOpenFile = null;
    return file;
});

ipcMain.handle('fs:readFileByPath', async (_, filePath: string) => {
    if (!filePath || typeof filePath !== 'string') return null;
    try {
        const buffer = await readFile(filePath);
        return {
            name: filePath.split(/[\\/]/).pop() || 'unknown',
            path: filePath,
            data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
        };
    } catch (error) {
        console.error('readFileByPath failed:', error);
        return null;
    }
});

const gotInstanceLock = !app.isPackaged || app.requestSingleInstanceLock();
if (!gotInstanceLock) {
    app.quit();
} else {
    app.on('second-instance', (_event, argv) => {
        const filePath = filePathFromArgv(argv);
        if (filePath) void openAssociatedPath(filePath);
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });
}

// macOS: can fire before ready
app.on('open-file', (event, filePath) => {
    event.preventDefault();
    if (app.isReady()) {
        void openAssociatedPath(filePath);
    } else {
        queuedOpenPath = filePath;
    }
});

if (gotInstanceLock) {
    app.whenReady().then(() => {
        createWindow();

        const toOpen = queuedOpenPath || filePathFromArgv(process.argv);
        queuedOpenPath = null;
        if (toOpen) void openAssociatedPath(toOpen);

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                createWindow();
            }
        });
    });
}

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

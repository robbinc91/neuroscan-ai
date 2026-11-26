/// <reference types="vite/client" />

export interface ElectronAPI {
    // File operations
    openFileDialog: (options?: {
        filters?: { name: string; extensions: string[] }[],
        properties?: ('openFile' | 'multiSelections' | 'openDirectory' | 'createDirectory')[]
    }) => Promise<Array<{ name: string; path: string; data: ArrayBuffer }> | null>;

    saveFile: (
        data: ArrayBuffer,
        defaultName: string,
        filters?: { name: string; extensions: string[] }[]
    ) => Promise<string | null>;
    selectDirectory: () => Promise<string | null>;
    readMedicalFolder: (dirPath?: string) => Promise<{
        root: string;
        files: Array<{ name: string; path: string; data: ArrayBuffer }>;
    } | null>;
    writeBundle: (
        directoryPath: string,
        files: Array<{
            relativePath: string;
            content: string;
            encoding?: 'utf8' | 'base64';
        }>
    ) => Promise<boolean>;

    // Settings store (encrypted)
    store: {
        get: (key: string) => Promise<any>;
        set: (key: string, value: any) => Promise<boolean>;
        delete: (key: string) => Promise<boolean>;
    };

    // App info
    getAppPath: (name: 'home' | 'appData' | 'userData' | 'temp' | 'downloads') => Promise<string>;
    getAppVersion: () => Promise<string>;

    // Menu event listeners
    onMenuImportScan: (callback: () => void) => () => void;
    onMenuImportFolder: (callback: () => void) => () => void;
    onMenuImportSegmentation: (callback: () => void) => () => void;
    onMenuExportReport: (callback: () => void) => () => void;
    onMenuExportVolume: (callback: () => void) => () => void;
    onMenuExportSegmentation: (callback: () => void) => () => void;
    readFileByPath: (filePath: string) => Promise<{ name: string; path: string; data: ArrayBuffer } | null>;
    onMenuOpenSettings: (callback: () => void) => () => void;
    onMenuUndo: (callback: () => void) => () => void;
    onMenuSetViewMode: (callback: (mode: string) => void) => () => void;

    // File association handler
    onFileOpened: (callback: (file: { name: string; path: string; data: ArrayBuffer }) => void) => () => void;
    takePendingOpenFile: () => Promise<{ name: string; path: string; data: ArrayBuffer } | null>;
}

declare global {
    interface Window {
        electron: ElectronAPI;
    }
}

export { };

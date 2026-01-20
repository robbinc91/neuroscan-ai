/// <reference types="vite/client" />

export interface ElectronAPI {
    // File operations
    openFileDialog: (options?: {
        filters?: { name: string; extensions: string[] }[],
        properties?: ('openFile' | 'multiSelections')[]
    }) => Promise<Array<{ name: string; path: string; data: ArrayBuffer }> | null>;

    saveFile: (
        data: ArrayBuffer,
        defaultName: string,
        filters?: { name: string; extensions: string[] }[]
    ) => Promise<string | null>;

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
    onMenuImportSegmentation: (callback: () => void) => () => void;
    onMenuExportReport: (callback: () => void) => () => void;
    onMenuOpenSettings: (callback: () => void) => () => void;

    // File association handler
    onFileOpened: (callback: (file: { name: string; path: string; data: ArrayBuffer }) => void) => () => void;
}

declare global {
    interface Window {
        electron: ElectronAPI;
    }
}

export { };

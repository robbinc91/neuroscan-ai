import { contextBridge, ipcRenderer } from 'electron';

// Exposed API for renderer process
const electronAPI = {
    // File operations
    openFileDialog: async (options?: {
        filters?: { name: string; extensions: string[] }[],
        properties?: ('openFile' | 'multiSelections')[]
    }) => {
        return await ipcRenderer.invoke('dialog:openFile', options);
    },

    saveFile: async (data: ArrayBuffer, defaultName: string, filters?: { name: string; extensions: string[] }[]) => {
        return await ipcRenderer.invoke('dialog:saveFile', data, defaultName, filters);
    },

    // Settings store (encrypted)
    store: {
        get: async (key: string) => {
            return await ipcRenderer.invoke('store:get', key);
        },
        set: async (key: string, value: any) => {
            return await ipcRenderer.invoke('store:set', key, value);
        },
        delete: async (key: string) => {
            return await ipcRenderer.invoke('store:delete', key);
        }
    },

    // App info
    getAppPath: async (name: 'home' | 'appData' | 'userData' | 'temp' | 'downloads') => {
        return await ipcRenderer.invoke('app:getPath', name);
    },

    getAppVersion: async () => {
        return await ipcRenderer.invoke('app:getVersion');
    },

    // Menu event listeners
    onMenuImportScan: (callback: () => void) => {
        ipcRenderer.on('menu-import-scan', callback);
        return () => ipcRenderer.removeListener('menu-import-scan', callback);
    },

    onMenuImportSegmentation: (callback: () => void) => {
        ipcRenderer.on('menu-import-segmentation', callback);
        return () => ipcRenderer.removeListener('menu-import-segmentation', callback);
    },

    onMenuExportReport: (callback: () => void) => {
        ipcRenderer.on('menu-export-report', callback);
        return () => ipcRenderer.removeListener('menu-export-report', callback);
    },

    onMenuOpenSettings: (callback: () => void) => {
        ipcRenderer.on('menu-open-settings', callback);
        return () => ipcRenderer.removeListener('menu-open-settings', callback);
    },

    // File association handler
    onFileOpened: (callback: (file: { name: string; path: string; data: ArrayBuffer }) => void) => {
        ipcRenderer.on('file-opened', (_, file) => callback(file));
        return () => ipcRenderer.removeAllListeners('file-opened');
    }
};

// Expose the API to the renderer process
contextBridge.exposeInMainWorld('electron', electronAPI);

// Type export for TypeScript
export type ElectronAPI = typeof electronAPI;

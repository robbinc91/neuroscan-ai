import type { ViewMode, WindowLevel } from '../types';
import type { DisplayConvention } from './orientation';

export interface RecentFile {
    path: string;
    name: string;
    openedAt: number;
}

const KEY_VIEW_MODE = 'session.viewMode';
const KEY_WINDOW_LEVEL = 'session.windowLevel';
const KEY_CONVENTION = 'session.displayConvention';
const KEY_RECENT = 'session.recentFiles';
const MAX_RECENT = 8;

export async function loadSessionPrefs(): Promise<{
    viewMode?: ViewMode;
    windowLevel?: WindowLevel;
    convention?: DisplayConvention;
    recentFiles: RecentFile[];
}> {
    if (!window.electron) return { recentFiles: [] };
    const [viewMode, windowLevel, convention, recentFiles] = await Promise.all([
        window.electron.store.get(KEY_VIEW_MODE),
        window.electron.store.get(KEY_WINDOW_LEVEL),
        window.electron.store.get(KEY_CONVENTION),
        window.electron.store.get(KEY_RECENT)
    ]);
    return {
        viewMode: viewMode as ViewMode | undefined,
        windowLevel: windowLevel && typeof windowLevel.width === 'number' && typeof windowLevel.center === 'number'
            ? { width: windowLevel.width, center: windowLevel.center }
            : undefined,
        convention: convention === 'neurological' ? 'neurological' : 'radiological',
        recentFiles: Array.isArray(recentFiles) ? recentFiles : []
    };
}

export async function saveViewMode(mode: ViewMode) {
    await window.electron?.store.set(KEY_VIEW_MODE, mode);
}

export async function saveWindowLevel(wl: WindowLevel) {
    await window.electron?.store.set(KEY_WINDOW_LEVEL, wl);
}

export async function saveConvention(convention: DisplayConvention) {
    await window.electron?.store.set(KEY_CONVENTION, convention);
}

export async function pushRecentFile(path: string, name: string): Promise<RecentFile[]> {
    if (!window.electron || !path) return [];
    const prev = (await window.electron.store.get(KEY_RECENT)) as RecentFile[] | undefined;
    const next: RecentFile[] = [
        { path, name, openedAt: Date.now() },
        ...(Array.isArray(prev) ? prev : []).filter((f) => f.path !== path)
    ].slice(0, MAX_RECENT);
    await window.electron.store.set(KEY_RECENT, next);
    return next;
}

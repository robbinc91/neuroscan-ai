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
const KEY_ANONYMIZE = 'session.anonymizeExports';
const MAX_RECENT = 8;

export async function loadSessionPrefs(): Promise<{
    viewMode?: ViewMode;
    windowLevel?: WindowLevel;
    convention?: DisplayConvention;
    recentFiles: RecentFile[];
    anonymizeExports: boolean;
}> {
    if (!window.electron) return { recentFiles: [], anonymizeExports: true };
    const [viewMode, windowLevel, convention, recentFiles, anonymize] = await Promise.all([
        window.electron.store.get(KEY_VIEW_MODE),
        window.electron.store.get(KEY_WINDOW_LEVEL),
        window.electron.store.get(KEY_CONVENTION),
        window.electron.store.get(KEY_RECENT),
        window.electron.store.get(KEY_ANONYMIZE)
    ]);
    return {
        viewMode: viewMode as ViewMode | undefined,
        windowLevel: windowLevel && typeof windowLevel.width === 'number' && typeof windowLevel.center === 'number'
            ? { width: windowLevel.width, center: windowLevel.center }
            : undefined,
        convention: convention === 'neurological' ? 'neurological' : 'radiological',
        recentFiles: Array.isArray(recentFiles) ? recentFiles : [],
        anonymizeExports: anonymize === false ? false : true
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

export async function saveAnonymizeExports(anonymize: boolean) {
    await window.electron?.store.set(KEY_ANONYMIZE, anonymize);
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

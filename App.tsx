import React, { useState, useRef, useEffect } from 'react';
import { Sidebar } from './components/Sidebar';
import { Viewport } from './components/Viewport';
import { ProcessingPanel } from './components/ProcessingPanel';
import { AnalysisPanel } from './components/AnalysisPanel';
import { ReportingPanel } from './components/ReportingPanel';
import { ComparisonPanel, ComparisonMode } from './components/ComparisonPanel';
import { SettingsDialog } from './components/SettingsDialog';
import { MetadataSidebar } from './components/MetadataSidebar';
import { ToolCategory, ViewMode, VolumeData, ViewportHandle, ViewportTool, Study, WindowLevel } from './types';
import { Menu, Loader2, Layers, FolderInput, Settings, LayoutGrid, Box, Info, FileText, History, Download } from 'lucide-react';
import { parseNiftiFile } from './utils/niftiUtils';
import { parseVolumeFromFile, parseVolumeFromFiles } from './utils/loadVolume';
import { autoWindowLevel } from './utils/windowLevel';
import { encodeNiftiGz } from './utils/niftiWrite';
import {
    loadSessionPrefs,
    pushRecentFile,
    saveConvention,
    saveViewMode,
    saveWindowLevel,
    type RecentFile
} from './utils/sessionStore';
import type { DisplayConvention } from './utils/orientation';
import { ensureVolumeMetadata, patientFooterLabel } from './utils/volumeMetadata';
import {
    computeVolumeDifferenceWithGeometry,
    computeSegmentationDifference,
    alignSegmentationToReferenceVolume
} from './utils/imageProcessing';

const LAYOUT_OPTIONS: { id: ViewMode; label: string; shortcut: string }[] = [
    { id: ViewMode.FourUp, label: '4-Up', shortcut: '0' },
    { id: ViewMode.Axial, label: 'Axial', shortcut: '1' },
    { id: ViewMode.Sagittal, label: 'Sagittal', shortcut: '2' },
    { id: ViewMode.Coronal, label: 'Coronal', shortcut: '3' },
    { id: ViewMode.ThreeD, label: '3D', shortcut: '4' },
];

const App: React.FC = () => {
    const [activeTool, setActiveTool] = useState<ToolCategory>(ToolCategory.Viewer);
    const [viewMode, setViewMode] = useState<ViewMode>(ViewMode.FourUp);

    // Single Study State (Backwards Compatibility)
    const [volume, setVolume] = useState<VolumeData | null>(null);
    const [sourceVolume, setSourceVolume] = useState<VolumeData | null>(null);
    const [volumeHistory, setVolumeHistory] = useState<VolumeData[]>([]);
    const [segmentationVolume, setSegmentationVolume] = useState<VolumeData | null>(null);

    // Multi-Study Comparison State
    const [studies, setStudies] = useState<Study[]>([]);
    const [diffVolume, setDiffVolume] = useState<VolumeData | null>(null);
    const [diffSeg, setDiffSeg] = useState<VolumeData | null>(null);
    const [comparisonMode, setComparisonMode] = useState<ComparisonMode>('split');
    const [overlayOpacity, setOverlayOpacity] = useState(0.5);

    // Viewport Interaction State
    const [isLoading, setIsLoading] = useState(false);
    const [viewportTool, setViewportTool] = useState<ViewportTool>('crosshair');
    const [brushSize, setBrushSize] = useState(5);
    const [brushLabel, setBrushLabel] = useState(1);
    const [windowLevel, setWindowLevel] = useState<WindowLevel | null>(null);
    const [displayConvention, setDisplayConvention] = useState<DisplayConvention>('radiological');
    const [cinePlaying, setCinePlaying] = useState(false);
    const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);
    const pendingWlRestoreRef = useRef<WindowLevel | null>(null);
    const [sessionReady, setSessionReady] = useState(false);
    const [paintUndoCount, setPaintUndoCount] = useState(0);
    const [menuOpen, setMenuOpen] = useState(false);

    // Shared Position for Sync
    const [sharedPosition, setSharedPosition] = useState({ x: 128, y: 128, z: 128 });

    // Settings Dialog State
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [exportRequestId, setExportRequestId] = useState(0);

    const viewportRef = useRef<ViewportHandle>(null);
    const volumeRef = useRef<VolumeData | null>(null);
    const segmentationRef = useRef<VolumeData | null>(null);
    const historyRef = useRef<VolumeData[]>([]);
    const menuRef = useRef<HTMLDivElement>(null);
    volumeRef.current = volume;
    segmentationRef.current = segmentationVolume;
    historyRef.current = volumeHistory;

    const loadVolume = (parsed: VolumeData, sourceName?: string) => {
        const next = sourceName && parsed.metadata
            ? { ...parsed, metadata: { ...parsed.metadata, sourceName } }
            : parsed;
        setSourceVolume(next);
        setVolume(next);
        setVolumeHistory([]);
        setSegmentationVolume(null);
        setWindowLevel(pendingWlRestoreRef.current ?? autoWindowLevel(next));
        pendingWlRestoreRef.current = null;
    };

    const rememberRecent = (filePath?: string, name?: string) => {
        if (!filePath) return;
        void pushRecentFile(filePath, name || filePath.split(/[\\/]/).pop() || 'scan').then(setRecentFiles);
    };

    const commitVolume = (next: VolumeData) => {
        const prev = volumeRef.current;
        if (prev && prev.data !== next.data) {
            setVolumeHistory([...historyRef.current.slice(-4), prev]);
        }
        setVolume(next);
    };

    const undoVolume = () => {
        const h = historyRef.current;
        if (h.length === 0) return;
        const prev = h[h.length - 1];
        setVolumeHistory(h.slice(0, -1));
        setVolume(prev);
    };

    const resetVolume = () => {
        if (!sourceVolume) return;
        setVolume(sourceVolume);
        setVolumeHistory([]);
    };

    // Update shared position bounds when volume loads
    useEffect(() => {
        if (volume) {
            setSharedPosition({
                x: Math.floor(volume.dimensions[0] / 2),
                y: Math.floor(volume.dimensions[1] / 2),
                z: Math.floor(volume.dimensions[2] / 2)
            });
        } else if (studies.length > 0 && activeTool === ToolCategory.Comparison) {
            // Also update for comparison studies if volume isn't active
            const v = studies[0].volume;
            setSharedPosition({
                x: Math.floor(v.dimensions[0] / 2),
                y: Math.floor(v.dimensions[1] / 2),
                z: Math.floor(v.dimensions[2] / 2)
            });
        }
    }, [volume, studies, activeTool]);

    const handleFileUpload = async () => {
        // Check if running in Electron
        if (!window.electron) {
            alert("This application must be run in Electron. Please build and run the desktop app.");
            return;
        }

        setIsLoading(true);
        try {
            const files = await window.electron.openFileDialog({
                filters: [
                    { name: 'Medical Images', extensions: ['nii', 'gz', 'dcm', 'ima'] },
                    { name: 'All Files', extensions: ['*'] }
                ],
                properties: ['openFile', 'multiSelections']
            });

            if (!files || files.length === 0) {
                setIsLoading(false);
                return;
            }

            const parsedVolume = parseVolumeFromFiles(files);

            if (parsedVolume) {
                loadVolume(parsedVolume, files[0].name);
                rememberRecent(files[0].path, files[0].name);
            } else {
                alert(`Failed to parse "${files[0].name}". Expected NIfTI (.nii, .nii.gz) or DICOM (.dcm, .ima).`);
            }
        } catch (e) {
            console.error("File upload error:", e);
            alert(`Error loading file(s): ${e instanceof Error ? e.message : 'Unknown error'}`);
        } finally {
            setIsLoading(false);
        }
    };

    const handleSegmentationUpload = async () => {
        // Check if running in Electron
        if (!window.electron) {
            alert("This application must be run in Electron. Please build and run the desktop app.");
            return;
        }

        setIsLoading(true);
        try {
            const files = await window.electron.openFileDialog({
                filters: [
                    { name: 'NIfTI Files', extensions: ['nii', 'gz'] },
                    { name: 'All Files', extensions: ['*'] }
                ],
                properties: ['openFile']
            });

            if (!files || files.length === 0) {
                setIsLoading(false);
                return;
            }

            const parsedVolume = parseNiftiFile(files[0].data);
            if (parsedVolume) setSegmentationVolume(parsedVolume);
            else alert("Failed to parse Segmentation file.");
        } catch (e) {
            console.error("Segmentation upload error:", e);
            alert(`Error loading segmentation: ${e instanceof Error ? e.message : 'Unknown error'}`);
        } finally {
            setIsLoading(false);
        }
    };

    const updateSegmentation = (vol: VolumeData | null) => {
        setSegmentationVolume(vol ? { ...vol } : null);
    };

    const requestReportExport = () => {
        if (!volumeRef.current) {
            alert('Load a scan before exporting a report.');
            return;
        }
        if (!segmentationRef.current) {
            setActiveTool(ToolCategory.Analysis);
            alert('Load or create a segmentation before exporting a report.');
            return;
        }
        setActiveTool(ToolCategory.Analysis);
        setExportRequestId((n) => n + 1);
    };

    const lastOpenedKeyRef = useRef('');
    const ingestOpenedFile = (file: { name: string; path: string; data: ArrayBuffer }, opts?: { force?: boolean }) => {
        const key = `${file.path}:${file.data.byteLength}`;
        if (!opts?.force && key === lastOpenedKeyRef.current) return;
        lastOpenedKeyRef.current = key;
        setIsLoading(true);
        try {
            const parsedVolume = parseVolumeFromFile(file.name, file.data);
            if (parsedVolume) {
                loadVolume(parsedVolume, file.name);
                rememberRecent(file.path, file.name);
            } else {
                alert(`Failed to parse "${file.name}". Expected NIfTI (.nii, .nii.gz) or DICOM (.dcm, .ima).`);
            }
        } catch (e) {
            console.error('Error opening associated file:', e);
            alert(`Error opening "${file.name}": ${e instanceof Error ? e.message : 'Unknown error'}`);
        } finally {
            setIsLoading(false);
        }
    };

    const exportNifti = async (kind: 'volume' | 'seg') => {
        if (!window.electron) {
            alert('Export is available in the desktop app.');
            return;
        }
        const vol = kind === 'seg' ? segmentationRef.current : volumeRef.current;
        if (!vol) {
            alert(kind === 'seg' ? 'Load or paint a segmentation before exporting.' : 'Load a scan before exporting.');
            return;
        }
        try {
            const gz = await encodeNiftiGz(vol, { mask: kind === 'seg' });
            const rawName = vol.metadata?.sourceName || volumeRef.current?.metadata?.sourceName || 'volume';
            const base = rawName.replace(/\.(nii\.gz|nii|dcm|ima)$/i, '');
            const defaultName = kind === 'seg' ? `${base}_seg.nii.gz` : `${base}_processed.nii.gz`;
            await window.electron.saveFile(gz, defaultName, [{ name: 'NIfTI gzip', extensions: ['gz'] }]);
        } catch (e) {
            console.error(e);
            alert(`Export failed: ${e instanceof Error ? e.message : 'Unknown error'}`);
        }
    };

    const openRecent = async (item: RecentFile) => {
        if (!window.electron) return;
        setIsLoading(true);
        try {
            const file = await window.electron.readFileByPath(item.path);
            if (!file) {
                alert(`Could not open "${item.path}". It may have been moved or deleted.`);
                return;
            }
            ingestOpenedFile(file, { force: true });
        } catch (e) {
            console.error(e);
            alert(`Error opening "${item.name}": ${e instanceof Error ? e.message : 'Unknown error'}`);
        } finally {
            setIsLoading(false);
        }
    };

    const requestReportExportRef = useRef(requestReportExport);
    requestReportExportRef.current = requestReportExport;
    const ingestOpenedFileRef = useRef(ingestOpenedFile);
    ingestOpenedFileRef.current = ingestOpenedFile;
    const exportNiftiRef = useRef(exportNifti);
    exportNiftiRef.current = exportNifti;

    // Electron menu event handlers
    useEffect(() => {
        if (!window.electron) return;

        const unsubscribeImportScan = window.electron.onMenuImportScan(() => {
            handleFileUpload();
        });

        const unsubscribeImportSeg = window.electron.onMenuImportSegmentation(() => {
            handleSegmentationUpload();
        });

        const unsubscribeExportReport = window.electron.onMenuExportReport(() => {
            requestReportExportRef.current();
        });

        const unsubscribeExportVolume = window.electron.onMenuExportVolume(() => {
            void exportNiftiRef.current('volume');
        });

        const unsubscribeExportSeg = window.electron.onMenuExportSegmentation(() => {
            void exportNiftiRef.current('seg');
        });

        const unsubscribeOpenSettings = window.electron.onMenuOpenSettings(() => {
            setSettingsOpen(true);
        });

        const unsubscribeViewMode = window.electron.onMenuSetViewMode((mode) => {
            if (Object.values(ViewMode).includes(mode as ViewMode)) {
                setViewMode(mode as ViewMode);
            }
        });

        const unsubscribeFileOpened = window.electron.onFileOpened((file) => {
            ingestOpenedFileRef.current(file);
        });

        void window.electron.takePendingOpenFile().then((file) => {
            if (file) ingestOpenedFileRef.current(file);
        });

        return () => {
            unsubscribeImportScan();
            unsubscribeImportSeg();
            unsubscribeExportReport();
            unsubscribeExportVolume();
            unsubscribeExportSeg();
            unsubscribeOpenSettings();
            unsubscribeViewMode();
            unsubscribeFileOpened();
        };
    }, []);

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            if (target) {
                const tag = target.tagName;
                if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
            }
            if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'z' || e.key === 'Z')) {
                if (e.shiftKey) return;
                e.preventDefault();
                if (viewportRef.current?.undoPaint()) return;
                undoVolume();
                return;
            }
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            if (e.key === 'p' || e.key === 'P') {
                e.preventDefault();
                setViewportTool('pan');
                return;
            }
            if (e.key === 'z' || e.key === 'Z') {
                e.preventDefault();
                setViewportTool('zoom');
                return;
            }
            if (e.key === 'b' || e.key === 'B') {
                e.preventDefault();
                setViewportTool('brush');
                return;
            }
            if (e.key === 'e' || e.key === 'E') {
                e.preventDefault();
                setViewportTool('eraser');
                return;
            }
            if (e.key === 'm' || e.key === 'M' || e.key === 'r' || e.key === 'R') {
                e.preventDefault();
                setViewportTool((t) => (t === 'measure' ? 'crosshair' : 'measure'));
                return;
            }
            if (e.key === 'c' || e.key === 'C') {
                e.preventDefault();
                setViewportTool('crosshair');
                return;
            }
            if (e.key === 'w' || e.key === 'W') {
                e.preventDefault();
                setViewportTool('wl');
                return;
            }
            if (e.key === 'i' || e.key === 'I') {
                e.preventDefault();
                setActiveTool(ToolCategory.Viewer);
                setMenuOpen(false);
                return;
            }
            const next =
                e.key === '0' || e.key === '5' ? ViewMode.FourUp
                : e.key === '1' ? ViewMode.Axial
                : e.key === '2' ? ViewMode.Sagittal
                : e.key === '3' ? ViewMode.Coronal
                : e.key === '4' ? ViewMode.ThreeD
                : null;
            if (!next) return;
            e.preventDefault();
            setViewMode(next);
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, []);

    useEffect(() => {
        if (!menuOpen) return;
        const onDoc = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                setMenuOpen(false);
            }
        };
        const onEsc = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setMenuOpen(false);
        };
        document.addEventListener('mousedown', onDoc);
        window.addEventListener('keydown', onEsc);
        return () => {
            document.removeEventListener('mousedown', onDoc);
            window.removeEventListener('keydown', onEsc);
        };
    }, [menuOpen]);

    useEffect(() => {
        let cancelled = false;
        void loadSessionPrefs().then((prefs) => {
            if (cancelled) return;
            if (prefs.viewMode && (Object.values(ViewMode) as string[]).includes(prefs.viewMode)) {
                setViewMode(prefs.viewMode);
            }
            if (prefs.windowLevel) pendingWlRestoreRef.current = prefs.windowLevel;
            if (prefs.convention) setDisplayConvention(prefs.convention);
            setRecentFiles(prefs.recentFiles);
            setSessionReady(true);
        });
        return () => { cancelled = true; };
    }, []);

    useEffect(() => {
        if (!sessionReady) return;
        void saveViewMode(viewMode);
    }, [viewMode, sessionReady]);

    useEffect(() => {
        if (!sessionReady) return;
        void saveConvention(displayConvention);
    }, [displayConvention, sessionReady]);

    useEffect(() => {
        if (!sessionReady || !windowLevel) return;
        const t = window.setTimeout(() => { void saveWindowLevel(windowLevel); }, 400);
        return () => window.clearTimeout(t);
    }, [windowLevel, sessionReady]);

    useEffect(() => {
        if (!volume && cinePlaying) setCinePlaying(false);
    }, [volume, cinePlaying]);

    // Drag and drop support
    const [isDragging, setIsDragging] = useState(false);

    useEffect(() => {
        const handleDragOver = (e: DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            setIsDragging(true);
        };

        const handleDragLeave = (e: DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            // Only hide overlay if leaving the window
            if (e.relatedTarget === null) {
                setIsDragging(false);
            }
        };

        const handleDrop = async (e: DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            setIsDragging(false);

            if (!e.dataTransfer?.files) return;

            const files = Array.from(e.dataTransfer.files);
            if (files.length === 0) return;

            setIsLoading(true);
            try {
                let parsedVolume: VolumeData | null = null;

                const buffers = await Promise.all(
                    files.map(async (file) => ({ name: file.name, data: await file.arrayBuffer() }))
                );
                parsedVolume = parseVolumeFromFiles(buffers);

                if (parsedVolume) {
                    loadVolume(parsedVolume, files[0].name);
                    const droppedPath = (files[0] as File & { path?: string }).path;
                    rememberRecent(droppedPath, files[0].name);
                } else {
                    alert(`Failed to parse "${files[0].name}". Expected NIfTI (.nii, .nii.gz) or DICOM (.dcm, .ima).`);
                }
            } catch (error) {
                console.error('Error processing dropped files:', error);
                alert("Error reading dropped file(s).");
            } finally {
                setIsLoading(false);
            }
        };

        document.addEventListener('dragover', handleDragOver);
        document.addEventListener('dragleave', handleDragLeave);
        document.addEventListener('drop', handleDrop);

        return () => {
            document.removeEventListener('dragover', handleDragOver);
            document.removeEventListener('dragleave', handleDragLeave);
            document.removeEventListener('drop', handleDrop);
        };
    }, []);


    const handleComputeDiff = () => {
        if (studies.length < 2) return;
        const vDiff = computeVolumeDifferenceWithGeometry(studies[0].volume, studies[1].volume);
        const segFollow = alignSegmentationToReferenceVolume(studies[1].segmentation, studies[0].volume);
        if (studies[1].segmentation && !segFollow) {
            alert(
                'Follow-up segmentation could not be aligned to the baseline grid (missing geometry or resample failure). Segmentation difference was skipped.'
            );
        }
        const sDiff = computeSegmentationDifference(studies[0].segmentation, segFollow, studies[0].volume);

        if (vDiff) setDiffVolume(vDiff);
        if (sDiff) setDiffSeg(sDiff);
        setComparisonMode('difference');
    };

    // Determine Viewport Content based on Mode
    const getComparisonViewportContent = () => {
        if (comparisonMode === 'difference') {
            return { volume: diffVolume || studies[1].volume, segmentation: diffSeg, colormap: 'hot-cold' as const };
        }
        if (comparisonMode === 'overlay') {
            // In overlay mode, we show Baseline as base, and Followup as overlay
            return {
                volume: studies[0].volume,
                segmentation: null,
                colormap: 'grayscale' as const,
                overlayVolume: studies[1].volume,
                overlayOpacity: overlayOpacity
            };
        }
        // Default 'split': Show Follow-up in the secondary viewport
        return { volume: studies[1].volume, segmentation: studies[1].segmentation, colormap: 'grayscale' as const };
    };

    const renderRightPanel = () => {
        switch (activeTool) {
            case ToolCategory.Processing:
            case ToolCategory.Segmentation:
                return (
                    <ProcessingPanel
                        mode={activeTool}
                        volume={volume}
                        onUpdateVolume={commitVolume}
                        onUpdateSegmentation={updateSegmentation}
                        canUndoVolume={volumeHistory.length > 0}
                        canResetVolume={!!volume && !!sourceVolume && volume.data !== sourceVolume.data}
                        onUndoVolume={undoVolume}
                        onResetVolume={resetVolume}
                        viewportTool={viewportTool}
                        onSelectViewportTool={setViewportTool}
                        brushSize={brushSize}
                        onBrushSizeChange={setBrushSize}
                        brushLabel={brushLabel}
                        onBrushLabelChange={setBrushLabel}
                        canUndoPaint={paintUndoCount > 0}
                        onUndoPaint={() => { viewportRef.current?.undoPaint(); }}
                    />
                );
            case ToolCategory.Analysis:
                return (
                    <AnalysisPanel
                        volume={volume}
                        segmentation={segmentationVolume}
                        onGenerateReport={() => viewportRef.current?.getReportImages()}
                        exportRequestId={exportRequestId}
                    />
                );
            case ToolCategory.Reporting:
                return (
                    <ReportingPanel
                        volume={volume}
                        segmentation={segmentationVolume}
                        onGenerateReport={() => viewportRef.current?.getReportImages()}
                        onOpenSettings={() => setSettingsOpen(true)}
                    />
                );
            case ToolCategory.Comparison:
                return (
                    <ComparisonPanel
                        studies={studies}
                        onAddStudy={(s) => {
                            setStudies(prev => [...prev, s]);
                            setWindowLevel((prev) => prev ?? autoWindowLevel(s.volume));
                        }}
                        onRemoveStudy={(id) => {
                            setStudies(prev => prev.filter(s => s.id !== id));
                            setDiffVolume(null);
                            setDiffSeg(null);
                            setComparisonMode('split');
                        }}
                        comparisonMode={comparisonMode}
                        onSetComparisonMode={setComparisonMode}
                        overlayOpacity={overlayOpacity}
                        onOverlayOpacityChange={setOverlayOpacity}
                        onComputeDiff={handleComputeDiff}
                        hasComputedDiff={!!diffVolume}
                    />
                );
            case ToolCategory.Viewer:
            default:
                return <MetadataSidebar volume={volume ?? studies[0]?.volume ?? null} />;
        }
    };

    const closeMenu = () => setMenuOpen(false);

    const wlProps = {
        windowLevel: windowLevel ?? undefined,
        onWindowLevelChange: (wl: WindowLevel) => setWindowLevel(wl)
    };

    const viewExtras = {
        displayConvention,
        onDisplayConventionChange: setDisplayConvention,
        cinePlaying,
        onCinePlayingChange: setCinePlaying
    };

    const footerVolume = volume ?? studies[0]?.volume ?? null;
    const footerPatient = patientFooterLabel(footerVolume ? ensureVolumeMetadata(footerVolume) : null);

    return (
        <div className="flex flex-col h-screen w-screen bg-gray-950 text-gray-100 font-sans overflow-hidden">
            <SettingsDialog isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />

            {/* Drag and Drop Overlay */}
            {isDragging && (
                <div className="fixed inset-0 bg-cyan-900/20 backdrop-blur-sm z-50 flex items-center justify-center pointer-events-none border-4 border-dashed border-cyan-400">
                    <div className="bg-gray-900 px-8 py-6 rounded-lg border-2 border-cyan-400 shadow-2xl">
                        <div className="text-2xl font-semibold text-cyan-400 mb-2 flex items-center gap-3">
                            <FolderInput className="w-8 h-8" />
                            Drop Medical Image Files
                        </div>
                        <p className="text-gray-400 text-center">NIfTI (.nii, .nii.gz) or DICOM(.dcm, .ima)</p>
                    </div>
                </div>
            )}


            {/* Header */}
            <header className="h-14 bg-gray-900 border-b border-gray-800 flex items-center px-4 z-30 shrink-0">
                <div className="flex-1 flex items-center gap-4 min-w-0">
                    <div className="relative" ref={menuRef}>
                        <button
                            type="button"
                            className="text-gray-400 hover:text-white"
                            aria-haspopup="menu"
                            aria-expanded={menuOpen}
                            title="Menu"
                            onClick={() => setMenuOpen((o) => !o)}
                        >
                            <Menu className="w-5 h-5" />
                        </button>
                        {menuOpen && (
                            <div
                                role="menu"
                                className="absolute left-0 top-full mt-1 w-64 max-h-[min(80vh,36rem)] overflow-y-auto rounded-lg border border-gray-700 bg-gray-900 py-1 shadow-xl z-50"
                            >
                                <button
                                    type="button"
                                    role="menuitem"
                                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-200 hover:bg-gray-800"
                                    onClick={() => { closeMenu(); handleFileUpload(); }}
                                >
                                    <FolderInput className="w-3.5 h-3.5 text-gray-400" />
                                    Import Scan
                                </button>
                                <button
                                    type="button"
                                    role="menuitem"
                                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-200 hover:bg-gray-800 disabled:opacity-40"
                                    disabled={!volume}
                                    onClick={() => { closeMenu(); handleSegmentationUpload(); }}
                                >
                                    <Layers className="w-3.5 h-3.5 text-green-400" />
                                    Load Segmentation
                                </button>
                                <button
                                    type="button"
                                    role="menuitem"
                                    className="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs text-gray-200 hover:bg-gray-800 disabled:opacity-40"
                                    disabled={!volume || !segmentationVolume}
                                    onClick={() => { closeMenu(); requestReportExport(); }}
                                >
                                    <span className="flex items-center gap-2">
                                        <FileText className="w-3.5 h-3.5 text-cyan-400" />
                                        Export Report
                                    </span>
                                    <span className="font-mono text-[10px] text-gray-500">Ctrl+E</span>
                                </button>
                                <button
                                    type="button"
                                    role="menuitem"
                                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-200 hover:bg-gray-800 disabled:opacity-40"
                                    disabled={!volume}
                                    onClick={() => { closeMenu(); void exportNifti('volume'); }}
                                >
                                    <Download className="w-3.5 h-3.5 text-cyan-400" />
                                    Export Volume (.nii.gz)
                                </button>
                                <button
                                    type="button"
                                    role="menuitem"
                                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-200 hover:bg-gray-800 disabled:opacity-40"
                                    disabled={!segmentationVolume}
                                    onClick={() => { closeMenu(); void exportNifti('seg'); }}
                                >
                                    <Download className="w-3.5 h-3.5 text-green-400" />
                                    Export Segmentation (.nii.gz)
                                </button>
                                <div className="my-1 h-px bg-gray-800" />
                                <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-gray-500 flex items-center gap-1.5">
                                    <History className="w-3 h-3" /> Recent
                                </div>
                                {recentFiles.length === 0 ? (
                                    <div className="px-3 py-1.5 text-[11px] text-gray-600">No recent files</div>
                                ) : recentFiles.map((item) => (
                                    <button
                                        key={item.path}
                                        type="button"
                                        role="menuitem"
                                        title={item.path}
                                        className="flex w-full items-center px-3 py-1.5 text-left text-xs text-gray-200 hover:bg-gray-800"
                                        onClick={() => { closeMenu(); void openRecent(item); }}
                                    >
                                        <span className="truncate">{item.name}</span>
                                    </button>
                                ))}
                                <div className="my-1 h-px bg-gray-800" />
                                {LAYOUT_OPTIONS.map((opt) => (
                                    <button
                                        key={opt.id}
                                        type="button"
                                        role="menuitem"
                                        className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-xs hover:bg-gray-800 ${
                                            viewMode === opt.id ? 'text-cyan-300' : 'text-gray-200'
                                        }`}
                                        onClick={() => { setViewMode(opt.id); closeMenu(); }}
                                    >
                                        <span className="flex items-center gap-2">
                                            {opt.id === ViewMode.FourUp ? <LayoutGrid className="w-3.5 h-3.5" /> : null}
                                            {opt.id === ViewMode.ThreeD ? <Box className="w-3.5 h-3.5" /> : null}
                                            {opt.label}
                                        </span>
                                        <span className="font-mono text-[10px] text-gray-500">{opt.shortcut}</span>
                                    </button>
                                ))}
                                <div className="my-1 h-px bg-gray-800" />
                                <button
                                    type="button"
                                    role="menuitem"
                                    className="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs text-gray-200 hover:bg-gray-800"
                                    onClick={() => { setActiveTool(ToolCategory.Viewer); closeMenu(); }}
                                >
                                    <span className="flex items-center gap-2">
                                        <Info className="w-3.5 h-3.5 text-cyan-400" />
                                        Scan Metadata
                                    </span>
                                    <span className="font-mono text-[10px] text-gray-500">I</span>
                                </button>
                                <button
                                    type="button"
                                    role="menuitem"
                                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-200 hover:bg-gray-800"
                                    onClick={() => { setSettingsOpen(true); closeMenu(); }}
                                >
                                    <Settings className="w-3.5 h-3.5 text-gray-400" />
                                    Settings
                                </button>
                            </div>
                        )}
                    </div>
                    <h1 className="text-lg font-bold tracking-tight flex items-center gap-2"><span className="text-cyan-400">NeuroScan</span> AI</h1>
                    <span className="bg-gray-800 text-xs px-2 py-0.5 rounded text-gray-400 border border-gray-700">v2.6-diff</span>
                </div>
                <div className="flex items-center gap-0.5 bg-gray-800/80 rounded-lg p-0.5 border border-gray-700" role="tablist" aria-label="Viewport layout">
                    {LAYOUT_OPTIONS.map((opt) => {
                        const active = viewMode === opt.id;
                        return (
                            <button
                                key={opt.id}
                                role="tab"
                                aria-selected={active}
                                onClick={() => setViewMode(opt.id)}
                                title={`${opt.label} (${opt.shortcut})`}
                                className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium uppercase tracking-wide transition-colors ${
                                    active
                                        ? 'bg-cyan-900/70 text-cyan-300'
                                        : 'text-gray-400 hover:text-gray-200 hover:bg-gray-700/80'
                                }`}
                            >
                                {opt.id === ViewMode.FourUp ? <LayoutGrid className="w-3.5 h-3.5" /> : null}
                                {opt.id === ViewMode.ThreeD ? <Box className="w-3.5 h-3.5" /> : null}
                                {opt.label}
                            </button>
                        );
                    })}
                </div>
                <div className="flex-1 flex items-center justify-end gap-3">
                    {activeTool !== ToolCategory.Comparison && (
                        <>
                            <button onClick={handleFileUpload} className="flex items-center gap-2 bg-gray-800 hover:bg-gray-700 text-sm px-3 py-1.5 rounded transition-colors border border-gray-700 disabled:opacity-50" disabled={isLoading}>
                                {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <FolderInput className="w-4 h-4" />}
                                <span>Import Scan</span>
                            </button>
                            <button onClick={handleSegmentationUpload} className="flex items-center gap-2 bg-gray-800 hover:bg-gray-700 text-sm px-3 py-1.5 rounded transition-colors border border-gray-700 disabled:opacity-50" disabled={isLoading || !volume}>
                                {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Layers className="w-4 h-4 text-green-400" />}
                                <span>Load Seg</span>
                            </button>
                        </>
                    )}
                    <div className="h-6 w-px bg-gray-700 mx-2" />
                    <button onClick={() => setSettingsOpen(true)} className="w-8 h-8 rounded-full bg-gray-800 hover:bg-gray-700 flex items-center justify-center text-gray-400 hover:text-gray-200 border border-gray-700 transition-colors" title="Settings">
                        <Settings className="w-4 h-4" />
                    </button>
                </div>
            </header>

            <div className="flex flex-1 overflow-hidden min-h-0">
                <Sidebar activeTool={activeTool} onSelectTool={setActiveTool} isSegmentationLoaded={!!segmentationVolume || (activeTool === ToolCategory.Comparison && studies.length > 0)} />

                <main className="flex-1 flex flex-col relative min-w-0 bg-black overflow-hidden">
                    {/* Main Content Area - Wrapped to handle flex sizing correctly */}
                    <div className="flex-1 flex flex-col min-h-0 relative">
                        {activeTool === ToolCategory.Comparison ? (
                            // COMPARISON MODE LOGIC
                            studies.length >= 2 ? (
                                comparisonMode === 'overlay' ? (
                                    // OVERLAY MODE: Single viewport showing Fusion
                                    <div className="flex-1 relative bg-gray-800 min-h-0">
                                        <div className="absolute top-0 left-0 right-0 z-10 text-center bg-gray-900/80 text-[10px] text-purple-400 py-0.5 pointer-events-none uppercase">
                                            FUSION OVERLAY (BASELINE + FOLLOW-UP)
                                        </div>
                                        <Viewport
                                            viewMode={viewMode}
                                            onViewModeChange={setViewMode}
                                            {...getComparisonViewportContent()}
                                            tool={viewportTool}
                                            onToolChange={setViewportTool}
                                            position={sharedPosition}
                                            onPositionChange={setSharedPosition}
                                            {...wlProps}
                                            {...viewExtras}
                                        />
                                    </div>
                                ) : (
                                    // SPLIT or DIFFERENCE MODE: Two viewports
                                    <div className="flex-1 grid grid-cols-2 gap-0.5 bg-gray-800 min-h-0">
                                        {/* Left Viewport (Baseline) */}
                                        <div className="relative">
                                            <div className="absolute top-0 left-0 right-0 z-10 text-center bg-gray-900/80 text-[10px] text-cyan-400 py-0.5 pointer-events-none">
                                                BASELINE
                                            </div>
                                            <Viewport
                                                viewMode={viewMode}
                                                onViewModeChange={setViewMode}
                                                volume={studies[0].volume}
                                                segmentation={studies[0].segmentation}
                                                tool={viewportTool}
                                                onToolChange={setViewportTool}
                                                position={sharedPosition}
                                                onPositionChange={setSharedPosition}
                                                {...wlProps}
                                                {...viewExtras}
                                            />
                                        </div>
                                        {/* Right Viewport (Difference or Follow-up) */}
                                        <div className="relative">
                                            <div className="absolute top-0 left-0 right-0 z-10 text-center bg-gray-900/80 text-[10px] text-green-400 py-0.5 pointer-events-none uppercase">
                                                {comparisonMode === 'difference' ? 'DIFFERENCE MAP' : 'FOLLOW-UP'}
                                            </div>
                                            <Viewport
                                                viewMode={viewMode}
                                                onViewModeChange={setViewMode}
                                                {...getComparisonViewportContent()}
                                                tool={viewportTool}
                                                onToolChange={setViewportTool}
                                                position={sharedPosition}
                                                onPositionChange={setSharedPosition}
                                                enableSliceKeys={false}
                                                {...wlProps}
                                                {...viewExtras}
                                            />
                                        </div>
                                    </div>
                                )
                            ) : (
                                // COMPARISON MODE: < 2 Studies (Preview first study or Empty)
                                <div className="flex-1 relative min-h-0">
                                    {studies.length === 1 && (
                                        <div className="absolute top-0 left-0 right-0 z-10 text-center bg-gray-900/80 text-[10px] text-cyan-400 py-0.5 pointer-events-none">
                                            BASELINE PREVIEW
                                        </div>
                                    )}
                                    <Viewport
                                        viewMode={viewMode}
                                        onViewModeChange={setViewMode}
                                        volume={studies.length > 0 ? studies[0].volume : null}
                                        segmentation={studies.length > 0 ? studies[0].segmentation : null}
                                        tool={viewportTool}
                                        onToolChange={setViewportTool}
                                        position={sharedPosition}
                                        onPositionChange={setSharedPosition}
                                        {...wlProps}
                                        {...viewExtras}
                                    />
                                </div>
                            )
                        ) : (
                            // STANDARD VIEWER MODE (Single Study)
                            <Viewport
                                ref={viewportRef}
                                viewMode={viewMode}
                                onViewModeChange={setViewMode}
                                volume={volume}
                                segmentation={segmentationVolume}
                                tool={viewportTool}
                                onToolChange={setViewportTool}
                                brushSize={brushSize}
                                onUpdateSegmentation={updateSegmentation}
                                position={sharedPosition}
                                onPositionChange={setSharedPosition}
                                brushLabel={brushLabel}
                                onPaintHistoryChange={setPaintUndoCount}
                                {...wlProps}
                                {...viewExtras}
                            />
                        )}
                    </div>

                    <div className="h-6 bg-gray-900 border-t border-gray-800 flex items-center justify-between px-4 text-[10px] text-gray-500 uppercase tracking-wider shrink-0 z-20">
                        <div>
                            {footerPatient} | {activeTool === ToolCategory.Comparison ? 'Comparison Mode' : 'Standard Viewer'} | Layout {viewMode.replace('_', '-')} (0–4)
                            {viewportTool === 'measure' ? ' | Measure: drag · Shift axis-lock · Esc cancel · Delete last' : ' | Pan P · Zoom Z · W/L W · Space cine · I metadata'}
                            {activeTool === ToolCategory.Processing || activeTool === ToolCategory.Segmentation ? ' | Ctrl+Z undo' : ''}
                        </div>
                        <div className="flex items-center gap-2">
                            {(volume || (activeTool === ToolCategory.Comparison && studies.length > 0)) && <span className="text-cyan-500">Scan Active</span>}
                        </div>
                    </div>
                </main>

                <aside className="w-80 bg-gray-900 border-l border-gray-800 flex flex-col z-10 shadow-xl overflow-hidden shrink-0">
                    <div className="h-10 border-b border-gray-800 flex items-center px-4 font-medium text-sm text-gray-200 shrink-0">
                        {activeTool === ToolCategory.Viewer && 'Scan Metadata'}
                        {activeTool === ToolCategory.Processing && 'Image Processing Pipeline'}
                        {activeTool === ToolCategory.Segmentation && 'Segmentation Tools'}
                        {activeTool === ToolCategory.Analysis && 'Quantitative Analysis'}
                        {activeTool === ToolCategory.Reporting && 'AI Reporting'}
                        {activeTool === ToolCategory.Comparison && 'Multi-Study Comparison'}
                    </div>
                    <div className="flex-1 overflow-hidden">
                        {renderRightPanel()}
                    </div>
                </aside>
            </div>
        </div>
    );
};

export default App;
import React, { useState, useRef, useEffect } from 'react';
import { Sidebar } from './components/Sidebar';
import { Viewport } from './components/Viewport';
import { ProcessingPanel } from './components/ProcessingPanel';
import { AnalysisPanel } from './components/AnalysisPanel';
import { ComparisonPanel, ComparisonMode } from './components/ComparisonPanel';
import { SettingsDialog } from './components/SettingsDialog';
import { ToolCategory, ViewMode, VolumeData, ViewportHandle, ViewportTool, Study } from './types';
import { Menu, Upload, User, Bell, Loader2, Layers, FolderInput, Settings } from 'lucide-react';
import { parseNiftiFile } from './utils/niftiUtils';
import { parseDicomFiles } from './utils/dicomUtils';
import { computeVolumeDifference, computeSegmentationDifference } from './utils/imageProcessing';

const App: React.FC = () => {
    const [activeTool, setActiveTool] = useState<ToolCategory>(ToolCategory.Viewer);
    const [viewMode, setViewMode] = useState<ViewMode>(ViewMode.FourUp);

    // Single Study State (Backwards Compatibility)
    const [volume, setVolume] = useState<VolumeData | null>(null);
    const [segmentationVolume, setSegmentationVolume] = useState<VolumeData | null>(null);

    // Multi-Study Comparison State
    const [studies, setStudies] = useState<Study[]>([]);
    const [diffVolume, setDiffVolume] = useState<VolumeData | null>(null);
    const [diffSeg, setDiffSeg] = useState<VolumeData | null>(null);
    const [comparisonMode, setComparisonMode] = useState<ComparisonMode>('split');
    const [overlayOpacity, setOverlayOpacity] = useState(0.5);

    // Viewport Interaction State
    const [isLoading, setIsLoading] = useState(false);
    const [viewportTool, setViewportTool] = useState<ViewportTool>('wl');
    const [brushSize, setBrushSize] = useState(5);

    // Shared Position for Sync
    const [sharedPosition, setSharedPosition] = useState({ x: 128, y: 128, z: 128 });

    // Settings Dialog State
    const [settingsOpen, setSettingsOpen] = useState(false);

    const viewportRef = useRef<ViewportHandle>(null);

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

            let parsedVolume: VolumeData | null = null;
            if (files.length === 1 && (files[0].name.toLowerCase().endsWith('.nii') || files[0].name.toLowerCase().endsWith('.nii.gz'))) {
                parsedVolume = parseNiftiFile(files[0].data);
            } else {
                const buffers = files.map(f => f.data);
                parsedVolume = parseDicomFiles(buffers);
            }

            if (parsedVolume) {
                setVolume(parsedVolume);
                setSegmentationVolume(null);
            } else {
                alert("Failed to parse file(s).");
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

    // Electron menu event handlers
    useEffect(() => {
        if (!window.electron) return;

        const unsubscribeImportScan = window.electron.onMenuImportScan(() => {
            handleFileUpload();
        });

        const unsubscribeImportSeg = window.electron.onMenuImportSegmentation(() => {
            handleSegmentationUpload();
        });

        const unsubscribeOpenSettings = window.electron.onMenuOpenSettings(() => {
            setSettingsOpen(true);
        });

        // Handle files opened via file association
        const unsubscribeFileOpened = window.electron.onFileOpened((file) => {
            setIsLoading(true);
            try {
                const parsedVolume = parseNiftiFile(file.data);
                if (parsedVolume) {
                    setVolume(parsedVolume);
                }
            } catch (e) {
                console.error('Error opening associated file:', e);
            } finally {
                setIsLoading(false);
            }
        });

        return () => {
            unsubscribeImportScan();
            unsubscribeImportSeg();
            unsubscribeOpenSettings();
            unsubscribeFileOpened();
        };
    }, []);

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

                if (files.length === 1 && (files[0].name.toLowerCase().endsWith('.nii') || files[0].name.toLowerCase().endsWith('.nii.gz'))) {
                    const arrayBuffer = await files[0].arrayBuffer();
                    parsedVolume = parseNiftiFile(arrayBuffer);
                } else {
                    const buffers: ArrayBuffer[] = [];
                    for (const file of files) {
                        buffers.push(await file.arrayBuffer());
                    }
                    parsedVolume = parseDicomFiles(buffers);
                }

                if (parsedVolume) {
                    setVolume(parsedVolume);
                    setSegmentationVolume(null);
                } else {
                    alert("Failed to parse dropped file(s).");
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
        const vDiff = computeVolumeDifference(studies[0].volume, studies[1].volume);
        const sDiff = computeSegmentationDifference(studies[0].segmentation, studies[1].segmentation, studies[0].volume.dimensions);

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
                        onUpdateVolume={setVolume}
                        onUpdateSegmentation={updateSegmentation}
                        viewportTool={viewportTool}
                        onSelectViewportTool={setViewportTool}
                        brushSize={brushSize}
                        onBrushSizeChange={setBrushSize}
                    />
                );
            case ToolCategory.Analysis:
            case ToolCategory.Reporting:
                return (
                    <AnalysisPanel
                        volume={volume}
                        segmentation={segmentationVolume}
                        onGenerateReport={() => viewportRef.current?.getReportImages()}
                    />
                );
            case ToolCategory.Comparison:
                return (
                    <ComparisonPanel
                        studies={studies}
                        onAddStudy={(s) => setStudies(prev => [...prev, s])}
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
            default:
                return (
                    <div className="p-6 text-center text-gray-500 mt-20">
                        <h3 className="text-lg font-medium text-gray-400 mb-2">Metadata</h3>
                        <p className="text-sm">Select a file or region to view details.</p>
                    </div>
                );
        }
    };

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
            <header className="h-14 bg-gray-900 border-b border-gray-800 flex items-center justify-between px-4 z-30 shrink-0">
                <div className="flex items-center gap-4">
                    <button className="text-gray-400 hover:text-white"><Menu className="w-5 h-5" /></button>
                    <h1 className="text-lg font-bold tracking-tight flex items-center gap-2"><span className="text-cyan-400">NeuroScan</span> AI</h1>
                    <span className="bg-gray-800 text-xs px-2 py-0.5 rounded text-gray-400 border border-gray-700">v2.6-diff</span>
                </div>
                <div className="flex items-center gap-3">
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
                                            {...getComparisonViewportContent()}
                                            tool={viewportTool}
                                            onToolChange={setViewportTool}
                                            position={sharedPosition}
                                            onPositionChange={setSharedPosition}
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
                                                volume={studies[0].volume}
                                                segmentation={studies[0].segmentation}
                                                tool={viewportTool}
                                                onToolChange={setViewportTool}
                                                position={sharedPosition}
                                                onPositionChange={setSharedPosition}
                                            />
                                        </div>
                                        {/* Right Viewport (Difference or Follow-up) */}
                                        <div className="relative">
                                            <div className="absolute top-0 left-0 right-0 z-10 text-center bg-gray-900/80 text-[10px] text-green-400 py-0.5 pointer-events-none uppercase">
                                                {comparisonMode === 'difference' ? 'DIFFERENCE MAP' : 'FOLLOW-UP'}
                                            </div>
                                            <Viewport
                                                viewMode={viewMode}
                                                {...getComparisonViewportContent()}
                                                tool={viewportTool}
                                                onToolChange={setViewportTool}
                                                position={sharedPosition}
                                                onPositionChange={setSharedPosition}
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
                                        volume={studies.length > 0 ? studies[0].volume : null}
                                        segmentation={studies.length > 0 ? studies[0].segmentation : null}
                                        tool={viewportTool}
                                        onToolChange={setViewportTool}
                                        position={sharedPosition}
                                        onPositionChange={setSharedPosition}
                                    />
                                </div>
                            )
                        ) : (
                            // STANDARD VIEWER MODE (Single Study)
                            <Viewport
                                ref={viewportRef}
                                viewMode={viewMode}
                                volume={volume}
                                segmentation={segmentationVolume}
                                tool={viewportTool}
                                onToolChange={setViewportTool}
                                brushSize={brushSize}
                                onUpdateSegmentation={updateSegmentation}
                                position={sharedPosition}
                                onPositionChange={setSharedPosition}
                            />
                        )}
                    </div>

                    <div className="h-6 bg-gray-900 border-t border-gray-800 flex items-center justify-between px-4 text-[10px] text-gray-500 uppercase tracking-wider shrink-0 z-20">
                        <div>Patient: ID-9382-AC | {activeTool === ToolCategory.Comparison ? 'Comparison Mode' : 'Standard Viewer'}</div>
                        <div className="flex items-center gap-2">
                            {(volume || (activeTool === ToolCategory.Comparison && studies.length > 0)) && <span className="text-cyan-500">Scan Active</span>}
                        </div>
                    </div>
                </main>

                {activeTool !== ToolCategory.Viewer && (
                    <aside className="w-80 bg-gray-900 border-l border-gray-800 flex flex-col z-10 shadow-xl overflow-hidden shrink-0">
                        <div className="h-10 border-b border-gray-800 flex items-center px-4 font-medium text-sm text-gray-200 shrink-0">
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
                )}
            </div>
        </div>
    );
};

export default App;
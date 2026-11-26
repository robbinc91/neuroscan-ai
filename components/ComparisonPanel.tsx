import React, { useMemo } from 'react';
import { Study } from '../types';
import { parseNiftiFileAsync } from '../utils/niftiUtils';
import { parseVolumeFromFilesAsync } from '../utils/loadVolume';
import { alignSegmentationToReferenceVolume } from '../utils/imageProcessing';
import { computeDiceAndVolumeChange } from '../utils/comparisonMetrics';
import { Layers, Plus, Trash2, GitCompare, Info, Eye, ArrowLeftRight } from 'lucide-react';
import { toast } from '../utils/toasts';

export type ComparisonMode = 'split' | 'difference' | 'overlay';

interface ComparisonPanelProps {
    studies: Study[];
    onAddStudy: (study: Study) => void;
    onRemoveStudy: (id: string) => void;
    onUpdateStudy: (id: string, patch: Partial<Study>) => void;
    onSwapStudies: () => void;
    comparisonMode: ComparisonMode;
    onSetComparisonMode: (mode: ComparisonMode) => void;
    overlayOpacity: number;
    onOverlayOpacityChange: (val: number) => void;
    onComputeDiff: () => void;
    hasComputedDiff: boolean;
}

export const ComparisonPanel: React.FC<ComparisonPanelProps> = ({
    studies, onAddStudy, onRemoveStudy, onUpdateStudy, onSwapStudies,
    comparisonMode, onSetComparisonMode,
    overlayOpacity, onOverlayOpacityChange,
    onComputeDiff, hasComputedDiff
}) => {
    const metrics = useMemo(() => {
        if (studies.length < 2) return null;
        const baseline = studies[0];
        const follow = studies[1];
        const segA = alignSegmentationToReferenceVolume(baseline.segmentation, baseline.volume);
        const segB = alignSegmentationToReferenceVolume(follow.segmentation, baseline.volume);
        return computeDiceAndVolumeChange(segA, segB, baseline.volume);
    }, [studies]);

    const loadStudy = async () => {
        if (!window.electron) {
            toast('Comparison loads NIfTI or DICOM in the desktop app.', 'warning');
            return;
        }
        try {
            const files = await window.electron.openFileDialog({
                filters: [
                    { name: 'Medical Images', extensions: ['nii', 'gz', 'dcm', 'ima'] },
                    { name: 'All Files', extensions: ['*'] }
                ],
                properties: ['openFile', 'multiSelections']
            });
            if (!files || files.length === 0) return;
            const vol = await parseVolumeFromFilesAsync(files);
            if (!vol) {
                toast(`Failed to parse "${files[0].name}". Expected NIfTI or DICOM.`);
                return;
            }
            const role = studies.length === 0 ? 'Baseline' : 'Follow-up';
            onAddStudy({
                id: `${Date.now()}`,
                name: files[0].name.replace(/\.(nii\.gz|nii|dcm|ima)$/i, '') || role,
                volume: vol,
                segmentation: null,
                date: new Date(),
                color: studies.length === 0 ? 'cyan' : 'green'
            });
        } catch (err) {
            console.error(err);
            toast('Failed to load volume');
        }
    };

    const loadSeg = async (studyId: string) => {
        if (!window.electron) {
            toast('Segmentation load requires the desktop app.', 'warning');
            return;
        }
        try {
            const files = await window.electron.openFileDialog({
                filters: [
                    { name: 'NIfTI Files', extensions: ['nii', 'gz'] },
                    { name: 'All Files', extensions: ['*'] }
                ],
                properties: ['openFile']
            });
            if (!files || files.length === 0) return;
            const vol = await parseNiftiFileAsync(files[0].data);
            if (!vol) {
                toast('Failed to parse segmentation.');
                return;
            }
            onUpdateStudy(studyId, { segmentation: vol });
        } catch (err) {
            console.error(err);
            toast('Failed to load segmentation');
        }
    };

    return (
        <div className="h-full flex flex-col p-4 gap-6 overflow-y-auto">
            <div>
                <h3 className="text-sm font-semibold text-gray-200 mb-3 uppercase tracking-wider flex items-center justify-between">
                    <span>Studies Loaded</span>
                    <span className="text-xs bg-gray-800 px-2 py-0.5 rounded text-gray-400">{studies.length}/2</span>
                </h3>

                <div className="space-y-3">
                    {studies.map((study, idx) => (
                        <div key={study.id} className={`bg-gray-800 border-l-4 rounded p-3 relative group ${idx === 0 ? 'border-cyan-500' : 'border-green-500'}`}>
                            <div className="flex justify-between items-start mb-2">
                                <div className="text-xs font-bold text-gray-200 truncate pr-4">{study.name}</div>
                                <button type="button" onClick={() => onRemoveStudy(study.id)} className="text-gray-500 hover:text-red-400">
                                    <Trash2 className="w-3 h-3" />
                                </button>
                            </div>
                            <div className="text-[10px] text-gray-500 font-mono mb-2">
                                Dims: {study.volume.dimensions.join('x')}
                            </div>

                            <div className="flex items-center gap-2">
                                <div className={`px-2 py-1 rounded text-[10px] flex items-center gap-1 bg-gray-900 border border-gray-700 ${study.segmentation ? 'text-green-400 border-green-900' : 'text-gray-500'}`}>
                                    <Layers className="w-3 h-3" />
                                    {study.segmentation ? 'Seg Loaded' : 'No Seg'}
                                </div>
                                {!study.segmentation && (
                                    <button type="button" onClick={() => void loadSeg(study.id)} className="text-[10px] text-cyan-500 hover:underline">
                                        + Upload
                                    </button>
                                )}
                            </div>
                            <div className="absolute top-1 right-8 text-[9px] font-bold text-gray-600">
                                {idx === 0 ? 'BASELINE' : 'FOLLOW-UP'}
                            </div>
                        </div>
                    ))}

                    {studies.length === 2 && (
                        <button
                            type="button"
                            onClick={onSwapStudies}
                            className="w-full py-2 bg-gray-800 border border-gray-700 hover:border-cyan-700 rounded text-xs text-gray-300 hover:text-cyan-300 flex items-center justify-center gap-2"
                        >
                            <ArrowLeftRight className="w-3 h-3" /> Swap baseline / follow-up
                        </button>
                    )}

                    {studies.length < 2 && (
                        <button
                            type="button"
                            onClick={() => void loadStudy()}
                            className="w-full py-4 border-2 border-dashed border-gray-700 hover:border-gray-500 rounded-lg flex flex-col items-center justify-center gap-2 text-gray-500 hover:text-gray-300 transition-colors"
                        >
                            <Plus className="w-6 h-6" />
                            <span className="text-xs">Load {studies.length === 0 ? 'Baseline' : 'Follow-up'} (NIfTI or DICOM)</span>
                        </button>
                    )}
                </div>
            </div>

            {studies.length === 2 && (
                <div className="border-t border-gray-800 pt-6 animate-in fade-in">
                    <h3 className="text-sm font-semibold text-gray-200 mb-3 uppercase tracking-wider">Comparison Mode</h3>

                    {!hasComputedDiff && (
                        <button
                            type="button"
                            onClick={onComputeDiff}
                            className="w-full py-2 bg-indigo-900/50 border border-indigo-700 hover:bg-indigo-800 text-indigo-300 text-xs rounded mb-4 flex items-center justify-center gap-2 transition-colors"
                        >
                            <GitCompare className="w-3 h-3" /> Compute Differences
                        </button>
                    )}

                    <div className="flex flex-col gap-2">
                        <div className="flex bg-gray-900 rounded p-1 border border-gray-800">
                            <button
                                type="button"
                                onClick={() => onSetComparisonMode('split')}
                                className={`flex-1 py-1.5 rounded text-xs transition-colors ${comparisonMode === 'split' ? 'bg-cyan-900 text-cyan-400' : 'text-gray-500 hover:text-gray-300'}`}
                            >
                                Side-by-Side
                            </button>
                            <button
                                type="button"
                                onClick={() => onSetComparisonMode('overlay')}
                                className={`flex-1 py-1.5 rounded text-xs transition-colors ${comparisonMode === 'overlay' ? 'bg-cyan-900 text-cyan-400' : 'text-gray-500 hover:text-gray-300'}`}
                            >
                                Overlay
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    if (!hasComputedDiff) onComputeDiff();
                                    onSetComparisonMode('difference');
                                }}
                                className={`flex-1 py-1.5 rounded text-xs transition-colors ${comparisonMode === 'difference' ? 'bg-cyan-900 text-cyan-400' : 'text-gray-500 hover:text-gray-300'}`}
                            >
                                Difference
                            </button>
                        </div>
                    </div>

                    {comparisonMode === 'overlay' && (
                        <div className="mt-4 bg-gray-800 p-3 rounded border border-gray-700 animate-in fade-in">
                            <div className="flex justify-between items-center text-xs text-gray-400 mb-2">
                                <span className="flex items-center gap-1"><Eye className="w-3 h-3" /> Overlay Opacity</span>
                                <span className="text-cyan-400 font-mono">{Math.round(overlayOpacity * 100)}%</span>
                            </div>
                            <input
                                type="range"
                                min="0" max="1" step="0.05"
                                value={overlayOpacity}
                                onChange={(e) => onOverlayOpacityChange(Number(e.target.value))}
                                className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                            />
                            <p className="text-[10px] text-gray-500 mt-2">
                                Follow-up (magenta) blended over baseline in 2D and 3D.
                            </p>
                        </div>
                    )}

                    {comparisonMode === 'difference' && (
                        <div className="mt-4 p-2 bg-gray-900/50 rounded text-xs text-gray-400 space-y-1 animate-in fade-in">
                            <div className="flex items-center gap-2">
                                <div className="w-3 h-3 bg-red-500 rounded-sm"></div>
                                <span>Disappeared (A only)</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <div className="w-3 h-3 bg-green-500 rounded-sm"></div>
                                <span>New / Appearance (B only)</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <div className="w-3 h-3 bg-blue-500 rounded-sm"></div>
                                <span>Intensity Change (Hot/Cold)</span>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {metrics && (
                <div className="border-t border-gray-800 pt-4">
                    <h3 className="text-sm font-semibold text-gray-200 mb-2 uppercase tracking-wider">Dice / volume change</h3>
                    {metrics.overallDice != null && (
                        <div className="text-xs text-cyan-300 font-mono mb-2">
                            Overall Dice {metrics.overallDice.toFixed(3)}
                        </div>
                    )}
                    <div className="bg-gray-800 rounded-lg overflow-hidden border border-gray-700">
                        <table className="w-full text-[11px] text-left">
                            <thead className="bg-gray-900 text-gray-400">
                                <tr>
                                    <th className="p-1.5 pl-2">Label</th>
                                    <th className="p-1.5">A cm³</th>
                                    <th className="p-1.5">B cm³</th>
                                    <th className="p-1.5">Δ</th>
                                    <th className="p-1.5">Dice</th>
                                </tr>
                            </thead>
                            <tbody className="text-gray-300">
                                {metrics.rows.length === 0 && (
                                    <tr>
                                        <td colSpan={5} className="p-3 text-center text-gray-600">Load masks on both studies for Dice</td>
                                    </tr>
                                )}
                                {metrics.rows.map((row) => (
                                    <tr key={row.labelId} className="border-t border-gray-700">
                                        <td className="p-1.5 pl-2 text-cyan-100">{row.label}</td>
                                        <td className="p-1.5 font-mono">{row.volACm3.toFixed(2)}</td>
                                        <td className="p-1.5 font-mono">{row.volBCm3.toFixed(2)}</td>
                                        <td className={`p-1.5 font-mono ${row.deltaCm3 >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                            {row.deltaCm3 >= 0 ? '+' : ''}{row.deltaCm3.toFixed(2)}
                                        </td>
                                        <td className="p-1.5 font-mono">{row.dice != null ? row.dice.toFixed(3) : '—'}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <p className="text-[10px] text-gray-500 mt-2 leading-snug">{metrics.note}</p>
                </div>
            )}

            <div className="mt-auto bg-gray-800/50 p-3 rounded border border-gray-700/50 text-[10px] text-gray-400 italic">
                <Info className="w-3 h-3 inline mr-1 mb-0.5" />
                Pairwise comparison. The open scan is added as baseline automatically. Overlay blends follow-up onto baseline; ensure scans are co-registered.
            </div>
        </div>
    );
};

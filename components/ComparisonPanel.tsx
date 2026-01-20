
import React, { useRef } from 'react';
import { Study, VolumeData } from '../types';
import { parseNiftiFile } from '../utils/niftiUtils';
import { Layers, Activity, Plus, Trash2, ArrowRight, GitCompare, Info, Eye, Blend, Sliders } from 'lucide-react';

export type ComparisonMode = 'split' | 'difference' | 'overlay';

interface ComparisonPanelProps {
    studies: Study[];
    onAddStudy: (study: Study) => void;
    onRemoveStudy: (id: string) => void;
    comparisonMode: ComparisonMode;
    onSetComparisonMode: (mode: ComparisonMode) => void;
    overlayOpacity: number;
    onOverlayOpacityChange: (val: number) => void;
    onComputeDiff: () => void;
    hasComputedDiff: boolean;
}

export const ComparisonPanel: React.FC<ComparisonPanelProps> = ({
    studies, onAddStudy, onRemoveStudy,
    comparisonMode, onSetComparisonMode,
    overlayOpacity, onOverlayOpacityChange,
    onComputeDiff, hasComputedDiff
}) => {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const segInputRef = useRef<HTMLInputElement>(null);
    const pendingStudyId = useRef<string | null>(null);

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        try {
            const buffer = await file.arrayBuffer();
            const vol = parseNiftiFile(buffer);
            if (vol) {
                const id = Date.now().toString();
                const newStudy: Study = {
                    id,
                    name: file.name.replace('.nii', '').replace('.gz', ''),
                    volume: vol,
                    segmentation: null,
                    date: new Date(),
                    color: studies.length === 0 ? 'cyan' : 'green'
                };
                onAddStudy(newStudy);
            }
        } catch (err) {
            console.error(err);
            alert("Failed to load volume");
        }
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    const handleSegUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file || !pendingStudyId.current) return;

        try {
            const buffer = await file.arrayBuffer();
            const vol = parseNiftiFile(buffer);
            if (vol) {
                const study = studies.find(s => s.id === pendingStudyId.current);
                if (study) {
                    onRemoveStudy(study.id);
                    onAddStudy({ ...study, segmentation: vol });
                }
            }
        } catch (err) {
            console.error(err);
            alert("Failed to load segmentation");
        }
        if (segInputRef.current) segInputRef.current.value = '';
        pendingStudyId.current = null;
    };

    const triggerSegUpload = (id: string) => {
        pendingStudyId.current = id;
        segInputRef.current?.click();
    };

    return (
        <div className="h-full flex flex-col p-4 gap-6 overflow-y-auto">
            <input type="file" ref={fileInputRef} onChange={handleFileUpload} accept=".nii,.nii.gz" className="hidden" />
            <input type="file" ref={segInputRef} onChange={handleSegUpload} accept=".nii,.nii.gz" className="hidden" />

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
                                <button onClick={() => onRemoveStudy(study.id)} className="text-gray-500 hover:text-red-400">
                                    <Trash2 className="w-3 h-3" />
                                </button>
                            </div>
                            <div className="text-[10px] text-gray-500 font-mono mb-2">
                                Dims: {study.volume.dimensions.join('x')}
                            </div>

                            <div className="flex items-center gap-2">
                                <div className={`px-2 py-1 rounded text-[10px] flex items-center gap-1 bg-gray-900 border border-gray-700 ${study.segmentation ? 'text-green-400 border-green-900' : 'text-gray-500'}`}>
                                    <Layers className="w-3 h-3" />
                                    {study.segmentation ? "Seg Loaded" : "No Seg"}
                                </div>
                                {!study.segmentation && (
                                    <button onClick={() => triggerSegUpload(study.id)} className="text-[10px] text-cyan-500 hover:underline">
                                        + Upload
                                    </button>
                                )}
                            </div>
                            <div className="absolute top-1 right-1 text-[9px] font-bold text-gray-600 opacity-20 group-hover:opacity-100">
                                {idx === 0 ? 'BASELINE' : 'FOLLOW-UP'}
                            </div>
                        </div>
                    ))}

                    {studies.length < 2 && (
                        <button
                            onClick={() => fileInputRef.current?.click()}
                            className="w-full py-4 border-2 border-dashed border-gray-700 hover:border-gray-500 rounded-lg flex flex-col items-center justify-center gap-2 text-gray-500 hover:text-gray-300 transition-colors"
                        >
                            <Plus className="w-6 h-6" />
                            <span className="text-xs">Load {studies.length === 0 ? 'Baseline' : 'Follow-up'} MRI</span>
                        </button>
                    )}
                </div>
            </div>

            {studies.length === 2 && (
                <div className="border-t border-gray-800 pt-6 animate-in fade-in">
                    <h3 className="text-sm font-semibold text-gray-200 mb-3 uppercase tracking-wider">Comparison Mode</h3>

                    {!hasComputedDiff && (
                        <button
                            onClick={onComputeDiff}
                            className="w-full py-2 bg-indigo-900/50 border border-indigo-700 hover:bg-indigo-800 text-indigo-300 text-xs rounded mb-4 flex items-center justify-center gap-2 transition-colors"
                        >
                            <GitCompare className="w-3 h-3" /> Compute Differences
                        </button>
                    )}

                    <div className="flex flex-col gap-2">
                        <div className="flex bg-gray-900 rounded p-1 border border-gray-800">
                            <button
                                onClick={() => onSetComparisonMode('split')}
                                className={`flex-1 py-1.5 rounded text-xs transition-colors ${comparisonMode === 'split' ? 'bg-cyan-900 text-cyan-400' : 'text-gray-500 hover:text-gray-300'}`}
                            >
                                Side-by-Side
                            </button>
                            <button
                                onClick={() => onSetComparisonMode('overlay')}
                                className={`flex-1 py-1.5 rounded text-xs transition-colors ${comparisonMode === 'overlay' ? 'bg-cyan-900 text-cyan-400' : 'text-gray-500 hover:text-gray-300'}`}
                            >
                                Overlay
                            </button>
                            <button
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
                                Blending Follow-up scan over Baseline.
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

            <div className="mt-auto bg-gray-800/50 p-3 rounded border border-gray-700/50 text-[10px] text-gray-400 italic">
                <Info className="w-3 h-3 inline mr-1 mb-0.5" />
                Ensure images are co-registered. Overlay mode blends Follow-up (FG) onto Baseline (BG).
            </div>
        </div>
    );
};

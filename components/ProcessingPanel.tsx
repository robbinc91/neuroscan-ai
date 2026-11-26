import React, { useState, useEffect, useRef } from 'react';
import { ToolCategory, VolumeData, ViewportTool } from '../types';
import { Play, RotateCcw, Loader2, Check, Trash2, Sliders, Wand2, UploadCloud, CloudLightning, Server, RefreshCw, PenTool, Eraser, MousePointer2, Hand, Info, Cpu } from 'lucide-react';
import { parseNiftiFile } from '../utils/niftiUtils';
import { cancelVolumeJob, runProcessJob, runSegmentJob, VolumeJobCancelled } from '../utils/volumeJob';
import { cancelInferenceJob, InferenceCancelled, InferenceTimeout, runInferenceJob } from '../utils/inferenceJob';
import { toast } from '../utils/toasts';

interface ProcessingPanelProps {
    mode: ToolCategory;
    volume?: VolumeData | null;
    onUpdateSegmentation?: (vol: VolumeData | null) => void;
    onUpdateVolume?: (vol: VolumeData | null) => void;
    viewportTool?: ViewportTool;
    onSelectViewportTool?: (tool: ViewportTool) => void;
    brushSize?: number;
    onBrushSizeChange?: (size: number) => void;
    brushLabel?: number;
    onBrushLabelChange?: (label: number) => void;
    canUndoPaint?: boolean;
    onUndoPaint?: () => void;
    canUndoVolume?: boolean;
    canResetVolume?: boolean;
    onUndoVolume?: () => void;
    onResetVolume?: () => void;
}

const LABEL_COLORS = ['#ef4444', '#22c55e', '#3b82f6', '#eab308', '#a855f7', '#ec4899', '#f97316', '#06b6d4', '#a3e635'];

interface ExternalModel {
    id: string;
    name: string;
    description: string;
    goal?: string;
    input_shape?: string | number[];
    input_format?: string;
    output_classes?: string[];
}

export const ProcessingPanel: React.FC<ProcessingPanelProps> = ({ 
    mode, volume, onUpdateSegmentation, onUpdateVolume,
    viewportTool, onSelectViewportTool, brushSize, onBrushSizeChange,
    brushLabel = 1, onBrushLabelChange, canUndoPaint, onUndoPaint,
    canUndoVolume, canResetVolume, onUndoVolume, onResetVolume
}) => {
    const [isProcessing, setIsProcessing] = useState(false);
    const [progress, setProgress] = useState(0);
    const [progressLabel, setProgressLabel] = useState('');
    const [completed, setCompleted] = useState(false);
    const [n4HighAccuracy, setN4HighAccuracy] = useState(false);
    
    // Processing State
    const [procMethod, setProcMethod] = useState<string>('hist_eq');
    const [param1, setParam1] = useState(1.0); // Generic Param 1 (Gamma, Sigma, Clip Limit)
    const [param2, setParam2] = useState(0.5); // Generic Param 2 (Cutoff, Gain)
    const [referenceVolume, setReferenceVolume] = useState<VolumeData | null>(null);
    const refInputRef = useRef<HTMLInputElement>(null);

    // Segmentation State
    const [segMethod, setSegMethod] = useState<string>('binary');
    const [manualThreshold, setManualThreshold] = useState(0);
    const [manualUpper, setManualUpper] = useState(0);
    const [localKernel, setLocalKernel] = useState(5);
    const [localOffset, setLocalOffset] = useState(2);

    // External Segmentation State
    const [serverUrl, setServerUrl] = useState('http://localhost:8000');
    const [models, setModels] = useState<ExternalModel[]>([]);
    const [selectedModelId, setSelectedModelId] = useState<string>('');
    const [isFetchingModels, setIsFetchingModels] = useState(false);
    const [modelsFetchStatus, setModelsFetchStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
    const [modelsFetchMessage, setModelsFetchMessage] = useState('');
    
    // Initialize defaults when volume loads
    useEffect(() => {
        if (volume) {
            const range = volume.max - volume.min;
            setManualThreshold(Math.floor(volume.min + range * 0.3)); // 30% default
            setManualUpper(Math.floor(volume.min + range * 0.7)); // 70% default
        }
    }, [volume]);

    // Reset params on method change
    useEffect(() => {
        if (procMethod.includes('gamma')) { setParam1(procMethod === 'gamma_bright' ? 0.6 : 1.5); setParam2(0.5); }
        else if (procMethod === 'sigmoid') { setParam1(10); setParam2(0.5); }
        else if (procMethod === 'clahe') { setParam1(2.0); setParam2(8); }
        else if (procMethod === 'gaussian') { setParam1(1.0); setParam2(0.5); }
        else if (procMethod === 'unsharp') { setParam1(1.0); setParam2(1.0); }
        else if (procMethod === 'median_3d') { setParam1(1); setParam2(0.5); }
        else if (procMethod === 'tv_denoise') { setParam1(15); setParam2(0.15); }
        else if (procMethod === 'n4_bias') { setParam1(50); setParam2(8); }
        else { setParam1(1.0); setParam2(0.5); }
        setCompleted(false);
    }, [procMethod]);

    // Auto-select Brush tool when Manual Drawing is selected
    useEffect(() => {
        if (mode === ToolCategory.Segmentation) {
            if (segMethod === 'manual_draw') {
                onSelectViewportTool?.('brush');
            } else if (viewportTool === 'brush' || viewportTool === 'eraser') {
                // If switching away from manual draw, reset to pointer if currently on brush
                onSelectViewportTool?.('crosshair');
            }
        }
    }, [segMethod, mode]);

    const handleRefUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const buf = await file.arrayBuffer();
            const vol = parseNiftiFile(buf);
            if (vol) setReferenceVolume(vol);
            else toast("Invalid NIfTI file");
        } catch (err) {
            console.error(err);
            toast("Error reading reference volume");
        }
    };

    useEffect(() => {
        return () => cancelVolumeJob();
    }, []);

    const runProcessing = async () => {
        if (!volume || !onUpdateVolume) return;
        cancelVolumeJob();
        setIsProcessing(true);
        setCompleted(false);
        setProgress(0);

        try {
            const job = runProcessJob(volume, procMethod, param1, param2, {
                reference: procMethod === 'hist_match' ? referenceVolume : null,
                highAccuracy: procMethod === 'n4_bias' && n4HighAccuracy,
                onProgress: setProgress
            });
            const result = await job.promise;
            onUpdateVolume({
                ...volume,
                data: result.data,
                min: result.min,
                max: result.max,
                geometryNotes: result.geometryNotes ?? volume.geometryNotes
            });
            setCompleted(true);
            setProgress(100);
        } catch (e: unknown) {
            if (e instanceof VolumeJobCancelled) return;
            console.error(e);
            toast('Processing failed: ' + (e instanceof Error ? e.message : 'Unknown error'));
        } finally {
            setIsProcessing(false);
        }
    };

    const runSegmentation = async () => {
        if (!volume || !onUpdateSegmentation) return;
        if (segMethod === 'manual_draw') {
            toast("Manual drawing is active. Use the Brush tool on the viewports.", 'info');
            return;
        }

        cancelVolumeJob();
        setIsProcessing(true);
        setCompleted(false);
        setProgress(0);

        try {
            const job = runSegmentJob(volume, segMethod, {
                manualThreshold,
                manualUpper,
                localKernel,
                localOffset
            }, { onProgress: setProgress });
            const result = await job.promise;
            onUpdateSegmentation({
                header: { ...volume.header, datatypeCode: 2 },
                dimensions: [volume.dimensions[0], volume.dimensions[1], volume.dimensions[2]],
                min: result.min,
                max: result.max,
                data: result.data,
                affine: volume.affine ? [...volume.affine] : undefined,
                coordSystem: volume.coordSystem,
                geometryNotes: result.geometryNotes
            });
            setCompleted(true);
            setProgress(100);
        } catch (e: unknown) {
            if (e instanceof VolumeJobCancelled) return;
            console.error(e);
            toast('Segmentation failed: ' + (e instanceof Error ? e.message : 'Unknown error'));
        } finally {
            setIsProcessing(false);
        }
    };

    const fetchModels = async () => {
        if (!serverUrl) return;
        setIsFetchingModels(true);
        setModelsFetchStatus('loading');
        setModelsFetchMessage('Loading available methods...');
        setModels([]);
        setSelectedModelId('');
        try {
            // Remove trailing slash if present for robustness
            const baseUrl = serverUrl.replace(/\/$/, '');
            const response = await fetch(`${baseUrl}/models`);
            
            if (!response.ok) {
                throw new Error(`Server returned ${response.status}`);
            }
            
            const data = await response.json();
            if (Array.isArray(data) && data.length > 0) {
                const normalized: ExternalModel[] = data.map((item: any, idx: number) => ({
                    id: String(item.id ?? item.method_id ?? idx),
                    name: String(item.name ?? item.method_name ?? item.id ?? `Method ${idx + 1}`),
                    description: String(item.description ?? 'No description provided.'),
                    goal: item.goal ? String(item.goal) : undefined,
                    input_shape: item.input_shape,
                    input_format: item.input_format ? String(item.input_format) : undefined,
                    output_classes: Array.isArray(item.output_classes) ? item.output_classes.map(String) : undefined
                }));
                setModels(normalized);
                setSelectedModelId(normalized[0].id);
                setModelsFetchStatus('success');
                setModelsFetchMessage(`${normalized.length} method${normalized.length > 1 ? 's' : ''} loaded.`);
            } else if (Array.isArray(data) && data.length === 0) {
                setModelsFetchStatus('error');
                setModelsFetchMessage("Connected, but no methods were found.");
            } else {
                throw new Error("Invalid response format. Expected JSON array.");
            }
        } catch (e: any) {
            console.error(e);
            setModelsFetchStatus('error');
            setModelsFetchMessage(`Connection failed: ${e.message}`);
        } finally {
            setIsFetchingModels(false);
        }
    };

    // Auto-fetch available methods whenever endpoint changes (debounced)
    useEffect(() => {
        if (mode !== ToolCategory.Segmentation) return;
        const trimmed = serverUrl.trim();
        if (!trimmed) {
            setModels([]);
            setSelectedModelId('');
            setModelsFetchStatus('idle');
            setModelsFetchMessage('');
            return;
        }

        const timeout = setTimeout(() => {
            fetchModels();
        }, 600);

        return () => clearTimeout(timeout);
    }, [serverUrl, mode]);

    const runBackendSegmentation = async () => {
        if (!volume || !onUpdateSegmentation || !selectedModelId) return;
        setIsProcessing(true);
        setProgress(0);
        setProgressLabel('starting');

        try {
            const segVol = await runInferenceJob({
                baseUrl: serverUrl,
                volume,
                modelId: selectedModelId,
                onProgress: (pct, label) => {
                    setProgress(pct);
                    setProgressLabel(label || '');
                }
            });

            if (segVol.header.datatypeCode !== 2) {
                const len = segVol.data.length;
                const maskData = new Uint8Array(len);
                for (let i = 0; i < len; i++) maskData[i] = segVol.data[i];
                segVol.data = maskData;
                segVol.header.datatypeCode = 2;
            }

            const d = volume.dimensions;
            const sd = segVol.dimensions;
            if (d[0] === sd[0] && d[1] === sd[1] && d[2] === sd[2] && volume.affine) {
                segVol.affine = [...volume.affine];
                segVol.coordSystem = volume.coordSystem;
                segVol.geometryNotes = `cloud_inference_output;aligned_to_input_volume;${segVol.geometryNotes || ''}`;
            }

            onUpdateSegmentation(segVol);
            setCompleted(true);
            setProgress(100);
            setProgressLabel('complete');
        } catch (e: unknown) {
            if (e instanceof InferenceCancelled) return;
            console.error(e);
            const message = e instanceof InferenceTimeout
                ? e.message
                : e instanceof Error ? e.message : 'Unknown error';
            toast(`External Segmentation Failed: ${message}`);
        } finally {
            setIsProcessing(false);
        }
    };

    const handleClear = () => {
        if (onUpdateSegmentation) onUpdateSegmentation(null);
        setCompleted(false);
    };

    const selectedModel = models.find(m => m.id === selectedModelId);

    if (mode === ToolCategory.Processing) {
        return (
            <div className="h-full flex flex-col p-4 gap-6 overflow-y-auto">
                <div>
                    <h3 className="text-sm font-semibold text-gray-200 mb-3 uppercase tracking-wider">Image Processing</h3>
                    <div className="relative mb-4">
                        <select 
                            value={procMethod}
                            onChange={(e) => setProcMethod(e.target.value)}
                            className="w-full bg-gray-800 border border-gray-700 text-gray-200 text-xs rounded p-2.5 appearance-none focus:ring-1 focus:ring-cyan-500 focus:border-cyan-500 outline-none"
                        >
                            <optgroup label="Enhancement">
                                <option value="clahe">CLAHE (tiled adaptive)</option>
                                <option value="hist_match">Histogram Matching (Reference)</option>
                                <option value="hist_eq">Global Histogram Equalization</option>
                                <option value="gamma_bright">Gamma Correction (Brighten)</option>
                                <option value="gamma_dark">Gamma Correction (Darken)</option>
                                <option value="sigmoid">Sigmoid Contrast Stretch</option>
                            </optgroup>
                            <optgroup label="Filtering / Denoising">
                                <option value="unsharp">Unsharp Masking (3D)</option>
                                <option value="gaussian">Gaussian Smoothing (3D)</option>
                                <option value="median_3d">3D Median Filter</option>
                                <option value="tv_denoise">Total Variation Denoise (3D)</option>
                            </optgroup>
                            <optgroup label="Bias Field Correction">
                                <option value="n4_bias">N4 Bias Field Correction</option>
                            </optgroup>
                        </select>
                         <div className="absolute inset-y-0 right-0 flex items-center px-2 pointer-events-none text-gray-400">
                            <ChevronDown />
                        </div>
                    </div>

                    <div className="bg-gray-800 p-3 rounded-lg border border-gray-700 space-y-3">
                         <div className="text-sm text-cyan-400 font-medium flex items-center gap-2">
                            <Sliders className="w-3 h-3" /> Configuration
                        </div>
                         {(procMethod === 'gamma_bright' || procMethod === 'gamma_dark') && (
                            <div className="space-y-1">
                                <label className="flex justify-between text-xs text-gray-400">
                                    <span>Gamma</span>
                                    <span className="font-mono">{param1.toFixed(2)}</span>
                                </label>
                                <input 
                                    type="range" min="0.1" max="3.0" step="0.1"
                                    value={param1}
                                    onChange={(e) => setParam1(Number(e.target.value))}
                                    className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                                />
                            </div>
                         )}

                         {procMethod === 'clahe' && (
                            <>
                                <div className="space-y-1">
                                    <label className="flex justify-between text-xs text-gray-400">
                                        <span>Clip Limit</span>
                                        <span className="font-mono">{param1.toFixed(1)}</span>
                                    </label>
                                    <input
                                        type="range" min="0.5" max="5.0" step="0.5"
                                        value={param1}
                                        onChange={(e) => setParam1(Number(e.target.value))}
                                        className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                                    />
                                </div>
                                <div className="space-y-1">
                                    <label className="flex justify-between text-xs text-gray-400">
                                        <span>Tile grid</span>
                                        <span className="font-mono">{Math.round(param2)}×{Math.round(param2)}</span>
                                    </label>
                                    <input
                                        type="range" min="4" max="16" step="1"
                                        value={param2}
                                        onChange={(e) => setParam2(Number(e.target.value))}
                                        className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                                    />
                                </div>
                                <div className="text-[10px] text-gray-500 italic leading-snug">
                                    Real tiled CLAHE (OpenCV-style): clipped per-tile CDFs, bilinear LUT blend, applied to every axial slice.
                                </div>
                            </>
                         )}

                         {procMethod === 'sigmoid' && (
                             <>
                                <div className="space-y-1">
                                    <label className="flex justify-between text-xs text-gray-400">
                                        <span>Gain</span>
                                        <span className="font-mono">{param1.toFixed(0)}</span>
                                    </label>
                                    <input 
                                        type="range" min="1" max="30" step="1"
                                        value={param1}
                                        onChange={(e) => setParam1(Number(e.target.value))}
                                        className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                                    />
                                </div>
                                <div className="space-y-1">
                                    <label className="flex justify-between text-xs text-gray-400">
                                        <span>Cutoff (Normalized)</span>
                                        <span className="font-mono">{param2.toFixed(2)}</span>
                                    </label>
                                    <input 
                                        type="range" min="0" max="1" step="0.05"
                                        value={param2}
                                        onChange={(e) => setParam2(Number(e.target.value))}
                                        className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                                    />
                                </div>
                             </>
                         )}

                         {procMethod === 'unsharp' && (
                            <>
                                <div className="space-y-1">
                                    <label className="flex justify-between text-xs text-gray-400">
                                        <span>Strength</span>
                                        <span className="font-mono">{param1.toFixed(1)}</span>
                                    </label>
                                    <input
                                        type="range" min="0.1" max="5.0" step="0.1"
                                        value={param1}
                                        onChange={(e) => setParam1(Number(e.target.value))}
                                        className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                                    />
                                </div>
                                <div className="space-y-1">
                                    <label className="flex justify-between text-xs text-gray-400">
                                    <span>Blur σ (mm)</span>
                                    <span className="font-mono">{param2.toFixed(2)}</span>
                                </label>
                                <input
                                    type="range" min="0.3" max="3.0" step="0.1"
                                    value={param2}
                                    onChange={(e) => setParam2(Number(e.target.value))}
                                    className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                                />
                                </div>
                                <div className="text-[10px] text-gray-500 italic leading-snug">
                                    3D unsharp in millimetres: anisotropic Gaussian (σ / voxel spacing on each axis), then original + strength × (original − blur).
                                </div>
                            </>
                         )}

                         {procMethod === 'tv_denoise' && (
                            <>
                                <div className="space-y-1">
                                    <label className="flex justify-between text-xs text-gray-400">
                                        <span>Iterations</span>
                                        <span className="font-mono">{Math.round(param1)}</span>
                                    </label>
                                    <input
                                        type="range" min="5" max="40" step="1"
                                        value={param1}
                                        onChange={(e) => setParam1(Number(e.target.value))}
                                        className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                                    />
                                </div>
                                <div className="space-y-1">
                                    <label className="flex justify-between text-xs text-gray-400">
                                        <span>Data fidelity (λ)</span>
                                        <span className="font-mono">{param2.toFixed(2)}</span>
                                    </label>
                                    <input
                                        type="range" min="0.05" max="0.5" step="0.01"
                                        value={param2}
                                        onChange={(e) => setParam2(Number(e.target.value))}
                                        className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                                    />
                                </div>
                                <div className="text-[10px] text-gray-500 italic leading-snug">
                                    3D Chambolle TV-L2. Higher λ keeps more detail; more iterations increase smoothing cost.
                                </div>
                            </>
                         )}

                         {procMethod === 'gaussian' && (
                            <div className="space-y-1">
                                <label className="flex justify-between text-xs text-gray-400">
                                    <span>Sigma (voxels)</span>
                                    <span className="font-mono">{param1.toFixed(2)}</span>
                                </label>
                                <input
                                    type="range" min="0.3" max="4.0" step="0.1"
                                    value={param1}
                                    onChange={(e) => setParam1(Number(e.target.value))}
                                    className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                                />
                                <div className="text-[10px] text-gray-500 italic leading-snug">
                                    Separable 3D Gaussian (X/Y/Z). Kernel radius is 3σ; edges use reflect padding.
                                </div>
                            </div>
                         )}

                         {procMethod === 'median_3d' && (
                            <div className="space-y-1">
                                <label className="flex justify-between text-xs text-gray-400">
                                    <span>Neighborhood</span>
                                    <span className="font-mono">{Math.round(param1) === 2 ? '5×5×5' : '3×3×3'}</span>
                                </label>
                                <input
                                    type="range" min="1" max="2" step="1"
                                    value={param1}
                                    onChange={(e) => setParam1(Number(e.target.value))}
                                    className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                                />
                                <div className="text-[10px] text-gray-500 italic leading-snug">
                                    True 3D median over the chosen cube. 5×5×5 is slower on large volumes.
                                </div>
                            </div>
                         )}

                         {procMethod === 'n4_bias' && (
                             <>
                                <div className="space-y-1">
                                    <label className="flex justify-between text-xs text-gray-400">
                                        <span>B-spline mesh spacing (mm)</span>
                                        <span className="font-mono">{param1.toFixed(0)}</span>
                                    </label>
                                    <input
                                        type="range" min="20" max="120" step="5"
                                        value={param1}
                                        onChange={(e) => setParam1(Number(e.target.value))}
                                        className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                                    />
                                </div>
                                <div className="space-y-1">
                                    <label className="flex justify-between text-xs text-gray-400">
                                        <span>Iterations per level</span>
                                        <span className="font-mono">{Math.round(param2)}</span>
                                    </label>
                                    <input
                                        type="range" min="2" max="20" step="1"
                                        value={param2}
                                        onChange={(e) => setParam2(Number(e.target.value))}
                                        className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                                    />
                                </div>
                                <label className="flex items-start gap-2 text-[10px] text-gray-400 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={n4HighAccuracy}
                                        onChange={(e) => setN4HighAccuracy(e.target.checked)}
                                        className="mt-0.5 rounded bg-gray-700 border-gray-600 text-cyan-500 focus:ring-0"
                                    />
                                    <span>
                                        High accuracy: extra spline level, and ITK-WASM N4 if <span className="font-mono">@itk-wasm/n4-bias-correction</span> is installed (otherwise the JS hierarchical N4).
                                    </span>
                                </label>
                                <div className="text-[10px] text-gray-500 italic leading-snug">
                                    Hierarchical N4: Otsu mask, log-domain Wiener histogram sharpening, cubic B-spline bias field. Background is left unchanged.
                                </div>
                             </>
                         )}

                         {procMethod === 'hist_match' && (
                            <div className="space-y-2 pt-1">
                                <label className="text-xs text-gray-400 flex justify-between">
                                    <span>Reference Volume</span>
                                    <span className="text-gray-500 italic">Required</span>
                                </label>
                                <button 
                                    onClick={() => refInputRef.current?.click()}
                                    className={`w-full py-2.5 border border-dashed rounded flex flex-col items-center justify-center gap-1 transition-colors ${referenceVolume ? 'border-cyan-500/50 bg-cyan-900/10' : 'border-gray-600 hover:border-gray-500 hover:bg-gray-700/50'}`}
                                >
                                    {referenceVolume ? (
                                        <>
                                            <Check className="w-4 h-4 text-green-400" />
                                            <span className="text-[10px] text-green-300">Reference Loaded</span>
                                            <span className="text-[9px] text-gray-500 font-mono">Dims: {referenceVolume.dimensions.join('x')}</span>
                                        </>
                                    ) : (
                                        <>
                                            <UploadCloud className="w-4 h-4 text-gray-400" />
                                            <span className="text-[10px] text-gray-400">Upload .nii Reference</span>
                                        </>
                                    )}
                                </button>
                                <input type="file" ref={refInputRef} onChange={handleRefUpload} className="hidden" accept=".nii,.nii.gz"/>
                            </div>
                         )}
                    </div>
                </div>

                 <div className="mt-auto space-y-2">
                    <div className="text-[10px] text-gray-500 leading-snug">
                        Runs in a background worker. The loaded scan is kept; Run Pipeline writes a copy.
                    </div>
                    <button 
                        onClick={runProcessing}
                        disabled={isProcessing || !volume || (procMethod === 'hist_match' && !referenceVolume)}
                        className="w-full py-3 bg-cyan-600 hover:bg-cyan-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-lg flex items-center justify-center gap-2 transition-colors shadow-lg"
                    >
                        {isProcessing ? <Loader2 className="animate-spin w-4 h-4"/> : completed ? <Check className="w-4 h-4"/> : <Wand2 className="w-4 h-4" />}
                        {isProcessing ? `Running ${progress}%` : completed ? 'Complete' : 'Run Pipeline'}
                    </button>
                    {isProcessing && (
                        <button
                            type="button"
                            onClick={() => { cancelVolumeJob(); setIsProcessing(false); setProgress(0); }}
                            className="w-full py-2 bg-gray-800 border border-gray-700 rounded text-xs text-red-300 hover:text-red-200"
                        >
                            Cancel
                        </button>
                    )}
                    <div className="flex gap-2">
                        <button
                            type="button"
                            onClick={onUndoVolume}
                            disabled={!canUndoVolume || isProcessing}
                            title="Undo last processing step (Ctrl+Z)"
                            className="flex-1 py-2 bg-gray-800 border border-gray-700 rounded text-xs text-gray-300 hover:text-cyan-300 disabled:text-gray-600 disabled:hover:text-gray-600 flex items-center justify-center gap-1"
                        >
                            <RotateCcw className="w-3 h-3" /> Undo
                        </button>
                        <button
                            type="button"
                            onClick={onResetVolume}
                            disabled={!canResetVolume || isProcessing}
                            title="Restore the original loaded scan"
                            className="flex-1 py-2 bg-gray-800 border border-gray-700 rounded text-xs text-gray-300 hover:text-cyan-300 disabled:text-gray-600 disabled:hover:text-gray-600 flex items-center justify-center gap-1"
                        >
                            Reset original
                        </button>
                    </div>
                 </div>
            </div>
        );
    }

    if (mode === ToolCategory.Segmentation) {
        return (
            <div className="h-full flex flex-col p-4 gap-6 overflow-y-auto">
                 <div>
                    <h3 className="text-sm font-semibold text-gray-200 mb-3 uppercase tracking-wider">Method</h3>
                    
                    <div className="relative mb-4">
                        <select 
                            value={segMethod}
                            onChange={(e) => setSegMethod(e.target.value)}
                            className="w-full bg-gray-800 border border-gray-700 text-gray-200 text-xs rounded p-2.5 appearance-none focus:ring-1 focus:ring-cyan-500 focus:border-cyan-500 outline-none"
                        >
                            <option value="manual_draw" className="text-cyan-400 font-bold">0. Manual Drawing (Brush)</option>
                            <optgroup label="Thresholding">
                                <option value="binary">1. Binary Threshold</option>
                                <option value="binary_inv">2. Binary Inverted</option>
                                <option value="truncate">3. Truncate (Cap Values)</option>
                                <option value="range_pass">4. Range Pass (Mid-tones)</option>
                            </optgroup>
                            <optgroup label="Automated (Global)">
                                <option value="otsu">5. Otsu's Method (2 Classes)</option>
                                <option value="li">6. Li's Method (2 Classes)</option>
                                <option value="multi_otsu">7. Multi-Otsu (3 Classes)</option>
                            </optgroup>
                            <optgroup label="Automated (Local)">
                                <option value="local_adaptive">8. Local Adaptive (Gaussian)</option>
                            </optgroup>
                        </select>
                        <div className="absolute inset-y-0 right-0 flex items-center px-2 pointer-events-none text-gray-400">
                            <ChevronDown />
                        </div>
                    </div>

                    <div className="bg-gray-800 p-3 rounded-lg border border-gray-700 space-y-3">
                        <div className="text-sm text-cyan-400 font-medium flex items-center gap-2">
                            <Sliders className="w-3 h-3" /> Parameters
                        </div>
                        
                        {segMethod === 'manual_draw' ? (
                            <div className="space-y-4 pt-1 animate-in fade-in">
                                <div className="flex gap-2">
                                    <button 
                                        onClick={() => onSelectViewportTool?.('brush')}
                                        className={`flex-1 py-2 border rounded text-xs flex items-center justify-center gap-2 transition-colors ${viewportTool === 'brush' ? 'bg-cyan-900 border-cyan-500 text-cyan-400' : 'bg-gray-800 border-gray-700 hover:text-cyan-400'}`}
                                    >
                                        <PenTool className="w-3 h-3" /> Brush
                                    </button>
                                    <button 
                                        onClick={() => onSelectViewportTool?.('eraser')}
                                        className={`flex-1 py-2 border rounded text-xs flex items-center justify-center gap-2 transition-colors ${viewportTool === 'eraser' ? 'bg-pink-900 border-pink-500 text-pink-400' : 'bg-gray-800 border-gray-700 hover:text-pink-400'}`}
                                    >
                                        <Eraser className="w-3 h-3" /> Eraser
                                    </button>
                                </div>
                                
                                <div className="bg-gray-900 p-2 rounded border border-gray-700">
                                    <div className="flex justify-between text-[10px] text-gray-400 mb-1">
                                        <span>Radius</span>
                                        <span>{brushSize} voxels</span>
                                    </div>
                                    <input 
                                        type="range" min="1" max="50" 
                                        value={brushSize} 
                                        onChange={(e) => onBrushSizeChange?.(Number(e.target.value))}
                                        className="w-full h-1 bg-gray-700 rounded cursor-pointer accent-cyan-500"
                                    />
                                </div>
                                <div className="bg-gray-900 p-2 rounded border border-gray-700 space-y-1.5">
                                    <div className="flex justify-between text-[10px] text-gray-400">
                                        <span>Label</span>
                                        <span className="font-mono">{brushLabel}</span>
                                    </div>
                                    <div className="grid grid-cols-9 gap-1">
                                        {LABEL_COLORS.map((color, i) => {
                                            const n = i + 1;
                                            const active = brushLabel === n;
                                            return (
                                                <button
                                                    key={n}
                                                    type="button"
                                                    title={`Paint label ${n}`}
                                                    onClick={() => onBrushLabelChange?.(n)}
                                                    className={`h-6 rounded text-[10px] font-mono ${active ? 'ring-2 ring-white text-black' : 'text-white/90'}`}
                                                    style={{ backgroundColor: color }}
                                                >
                                                    {n}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                                <button
                                    type="button"
                                    onClick={onUndoPaint}
                                    disabled={!canUndoPaint}
                                    title="Undo last brush stroke (Ctrl+Z)"
                                    className="w-full py-2 bg-gray-800 border border-gray-700 rounded text-xs text-gray-300 hover:text-cyan-300 disabled:text-gray-600 disabled:hover:text-gray-600 flex items-center justify-center gap-1"
                                >
                                    <RotateCcw className="w-3 h-3" /> Undo stroke
                                </button>
                                <div className="text-[10px] text-gray-400 italic flex items-start gap-1">
                                    <Hand className="w-3 h-3 shrink-0 mt-0.5" />
                                    Sphere in voxel space. Ctrl+Z undoes the last stroke.
                                </div>
                            </div>
                        ) : (
                            <>
                                {(segMethod === 'binary' || segMethod === 'binary_inv' || segMethod === 'truncate') && (
                                    <div className="space-y-1">
                                        <label className="flex justify-between text-xs text-gray-400">
                                            <span>Threshold</span>
                                            <span className="font-mono">{manualThreshold}</span>
                                        </label>
                                        <input 
                                            type="range" 
                                            min={volume?.min || 0} 
                                            max={volume?.max || 255} 
                                            value={manualThreshold}
                                            onChange={(e) => setManualThreshold(Number(e.target.value))}
                                            className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                                        />
                                    </div>
                                )}

                                {segMethod === 'range_pass' && (
                                    <>
                                    <div className="space-y-1">
                                        <label className="flex justify-between text-xs text-gray-400">
                                            <span>Lower Bound</span>
                                            <span className="font-mono">{manualThreshold}</span>
                                        </label>
                                        <input 
                                            type="range" 
                                            min={volume?.min || 0} 
                                            max={volume?.max || 255} 
                                            value={manualThreshold}
                                            onChange={(e) => setManualThreshold(Math.min(Number(e.target.value), manualUpper))}
                                            className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                                        />
                                    </div>
                                    <div className="space-y-1">
                                        <label className="flex justify-between text-xs text-gray-400">
                                            <span>Upper Bound</span>
                                            <span className="font-mono">{manualUpper}</span>
                                        </label>
                                        <input 
                                            type="range" 
                                            min={volume?.min || 0} 
                                            max={volume?.max || 255} 
                                            value={manualUpper}
                                            onChange={(e) => setManualUpper(Math.max(Number(e.target.value), manualThreshold))}
                                            className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                                        />
                                    </div>
                                    </>
                                )}
                                
                                {segMethod === 'local_adaptive' && (
                                    <>
                                    <div className="space-y-1">
                                        <label className="flex justify-between text-xs text-gray-400">
                                            <span>Kernel Size</span>
                                            <span className="font-mono">{localKernel}×{localKernel}</span>
                                        </label>
                                        <input 
                                            type="range" 
                                            min="3" max="21" step="2"
                                            value={localKernel}
                                            onChange={(e) => setLocalKernel(Number(e.target.value))}
                                            className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                                        />
                                    </div>
                                    <div className="space-y-1">
                                        <label className="flex justify-between text-xs text-gray-400">
                                            <span>Offset C (% of range)</span>
                                            <span className="font-mono">{localOffset.toFixed(1)}</span>
                                        </label>
                                        <input
                                            type="range"
                                            min="0" max="20" step="0.5"
                                            value={localOffset}
                                            onChange={(e) => setLocalOffset(Number(e.target.value))}
                                            className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                                        />
                                    </div>
                                    <div className="text-[10px] text-gray-500 italic leading-snug">
                                        Gaussian-weighted local mean on each axial slice (σ = (k−1)/6). A voxel is labeled 1 if it is brighter than that mean minus C, and the neighborhood is above a volume Otsu floor so air is not filled.
                                    </div>
                                    </>
                                )}

                                {['otsu', 'li', 'multi_otsu'].includes(segMethod) && (
                                    <div className="text-xs text-gray-500 italic">
                                        Thresholds will be calculated automatically based on intensity histogram.
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                </div>

                 <div>
                    <h3 className="text-sm font-semibold text-gray-200 mb-3 uppercase tracking-wider">Operations</h3>
                     <div className="space-y-2">
                        <button onClick={handleClear} className="w-full py-2 bg-gray-800 border border-gray-700 rounded text-xs hover:text-red-400 text-red-400/80 transition-colors flex items-center justify-center gap-1">
                            <Trash2 className="w-3 h-3" /> Clear All Masks
                        </button>
                    </div>
                 </div>
                 
                 <div className="flex flex-col gap-2 mt-auto">
                    {segMethod !== 'manual_draw' ? (
                        <>
                        <button 
                            onClick={runSegmentation}
                            disabled={isProcessing || !volume}
                            className="w-full py-3 bg-cyan-600 hover:bg-cyan-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-lg flex items-center justify-center gap-2 transition-colors"
                        >
                            {isProcessing ? <Loader2 className="animate-spin w-4 h-4"/> : <Play className="w-4 h-4" />}
                            {isProcessing ? `Segmenting ${progress}%` : 'Generate Masks'}
                        </button>
                        {isProcessing && (
                            <button
                                type="button"
                                onClick={() => { cancelVolumeJob(); setIsProcessing(false); setProgress(0); }}
                                className="w-full py-2 bg-gray-800 border border-gray-700 rounded text-xs text-red-300 hover:text-red-200"
                            >
                                Cancel
                            </button>
                        )}
                        </>
                    ) : (
                         <div className="w-full py-3 bg-gray-800 border border-gray-700 text-gray-400 rounded-lg flex items-center justify-center gap-2 text-xs">
                            <MousePointer2 className="w-3 h-3" /> Interactive Mode Active
                        </div>
                    )}

                    <div className="pt-4 border-t border-gray-800">
                        <h3 className="text-xs font-semibold text-gray-400 mb-2 uppercase tracking-wider flex items-center gap-1">
                            <CloudLightning className="w-3 h-3 text-purple-400" /> External / Cloud Inference
                        </h3>
                        <div className="space-y-3">
                            <div className="flex gap-2">
                                <div className="flex-1 flex items-center gap-2 bg-gray-900 border border-gray-700 rounded px-2">
                                    <Server className="w-3 h-3 text-gray-500" />
                                    <input 
                                        type="text" 
                                        value={serverUrl}
                                        onChange={(e) => setServerUrl(e.target.value)}
                                        placeholder="http://localhost:8000"
                                        className="w-full bg-transparent border-none text-xs text-gray-300 py-2 focus:ring-0 focus:outline-none"
                                    />
                                </div>
                                <button 
                                    onClick={fetchModels}
                                    disabled={isFetchingModels || !serverUrl}
                                    className="px-3 py-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded text-xs text-cyan-400 transition-colors disabled:opacity-50"
                                    title="Fetch Available Models"
                                >
                                    {isFetchingModels ? <Loader2 className="w-4 h-4 animate-spin"/> : <RefreshCw className="w-4 h-4" />}
                                </button>
                            </div>

                            {modelsFetchStatus !== 'idle' && (
                                <div className={`text-[10px] px-2 py-1 rounded border ${modelsFetchStatus === 'success'
                                    ? 'text-green-300 border-green-800/70 bg-green-900/20'
                                    : modelsFetchStatus === 'error'
                                        ? 'text-red-300 border-red-800/70 bg-red-900/20'
                                        : 'text-cyan-300 border-cyan-800/70 bg-cyan-900/20'
                                    }`}>
                                    {modelsFetchMessage}
                                </div>
                            )}

                            {models.length > 0 && (
                                <div className="space-y-2 animate-in fade-in slide-in-from-top-2">
                                    <div className="text-[10px] text-gray-400 uppercase tracking-wider">Available Methods</div>
                                    <div className="max-h-44 overflow-y-auto space-y-2 pr-1">
                                        {models.map((m) => (
                                            <button
                                                key={m.id}
                                                onClick={() => setSelectedModelId(m.id)}
                                                className={`w-full text-left p-2 rounded border transition-colors ${selectedModelId === m.id
                                                    ? 'border-purple-500 bg-purple-900/30'
                                                    : 'border-gray-700 bg-gray-800/50 hover:border-gray-500'
                                                    }`}
                                            >
                                                <div className="text-xs text-gray-100 font-medium">{m.name}</div>
                                                <div className="text-[10px] text-gray-400 mt-0.5">{m.description}</div>
                                                {(m.input_format || m.input_shape) && (
                                                    <div className="text-[10px] text-cyan-300 font-mono mt-1">
                                                        Input: {m.input_format || (Array.isArray(m.input_shape) ? m.input_shape.join('x') : m.input_shape)}
                                                    </div>
                                                )}
                                            </button>
                                        ))}
                                    </div>

                                    {selectedModel && (
                                        <div className="bg-gray-800/50 p-2 rounded border border-gray-700/50 text-[10px] space-y-1">
                                            <div className="flex gap-1.5 items-start">
                                                <Info className="w-3 h-3 text-purple-400 shrink-0 mt-0.5" />
                                                <span className="text-gray-300 italic">{selectedModel.description}</span>
                                            </div>
                                            {selectedModel.goal && (
                                                <div className="text-gray-500">Goal: {selectedModel.goal}</div>
                                            )}
                                            {selectedModel.input_shape && (
                                                <div className="text-gray-500 font-mono">Input shape: {Array.isArray(selectedModel.input_shape) ? selectedModel.input_shape.join('x') : selectedModel.input_shape}</div>
                                            )}
                                            {selectedModel.input_format && (
                                                <div className="text-gray-500 font-mono">Input format: {selectedModel.input_format}</div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            )}

                            <button 
                                onClick={runBackendSegmentation}
                                disabled={isProcessing || !volume || !selectedModelId || isFetchingModels || models.length === 0}
                                className="w-full py-2 bg-purple-900/40 border border-purple-800/50 hover:bg-purple-900/60 hover:border-purple-500 text-purple-300 text-xs rounded transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {isProcessing ? <Loader2 className="animate-spin w-3 h-3"/> : <Cpu className="w-3 h-3" />}
                                {isFetchingModels
                                    ? 'Loading Methods...'
                                    : isProcessing
                                        ? `${progress}%${progressLabel ? ` ${progressLabel}` : ''}`
                                        : 'Run Inference'}
                            </button>
                            {isProcessing && (
                                <button
                                    type="button"
                                    onClick={() => { cancelInferenceJob(); cancelVolumeJob(); setIsProcessing(false); setProgress(0); setProgressLabel(''); }}
                                    className="w-full py-2 bg-gray-800 border border-gray-700 rounded text-xs text-red-300 hover:text-red-200"
                                >
                                    Cancel inference
                                </button>
                            )}
                            <div className="text-[10px] text-gray-500 leading-snug">
                                Prefers POST /jobs and polls GET /jobs/{'{id}'} (BACKEND_SPEC §12). Falls back to POST /predict. Progress is server-reported or download bytes — not a fake 10/30/60/100. 5-minute timeout.
                            </div>
                        </div>
                    </div>
                 </div>
            </div>
        )
    }

    return <div className="p-4 text-gray-500 text-sm">Select a tool to configure parameters.</div>;
};
function ChevronDown(props: React.JSX.IntrinsicAttributes & React.SVGProps<SVGSVGElement>) {
    return <svg {...props} className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path></svg>;
}
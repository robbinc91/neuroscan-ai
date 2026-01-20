import React, { useState, useEffect, useRef } from 'react';
import { ProcessingMethod, ToolCategory, VolumeData, ViewportTool } from '../types';
import { Play, RotateCcw, Save, Loader2, Check, Trash2, Sliders, Wand2, UploadCloud, CloudLightning, Server, RefreshCw, Info, Cpu, PenTool, Eraser, Hand, MousePointer2 } from 'lucide-react';
import { parseNiftiFile } from '../utils/niftiUtils';

interface ProcessingPanelProps {
    mode: ToolCategory;
    volume?: VolumeData | null;
    onUpdateSegmentation?: (vol: VolumeData | null) => void;
    onUpdateVolume?: (vol: VolumeData | null) => void;
    viewportTool?: ViewportTool;
    onSelectViewportTool?: (tool: ViewportTool) => void;
    brushSize?: number;
    onBrushSizeChange?: (size: number) => void;
}

interface ExternalModel {
    id: string;
    name: string;
    description: string;
    goal?: string;
    input_shape?: string | number[];
    output_classes?: string[];
}

export const ProcessingPanel: React.FC<ProcessingPanelProps> = ({ 
    mode, volume, onUpdateSegmentation, onUpdateVolume,
    viewportTool, onSelectViewportTool, brushSize, onBrushSizeChange
}) => {
    const [isProcessing, setIsProcessing] = useState(false);
    const [progress, setProgress] = useState(0);
    const [completed, setCompleted] = useState(false);
    
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

    // External Segmentation State
    const [serverUrl, setServerUrl] = useState('http://localhost:8000');
    const [models, setModels] = useState<ExternalModel[]>([]);
    const [selectedModelId, setSelectedModelId] = useState<string>('');
    const [isFetchingModels, setIsFetchingModels] = useState(false);
    
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
        if (procMethod.includes('gamma')) setParam1(procMethod === 'gamma_bright' ? 0.6 : 1.5);
        else if (procMethod === 'sigmoid') { setParam1(10); setParam2(0.5); }
        else if (procMethod === 'clahe') setParam1(2.0); // Clip limit
        else if (procMethod === 'gaussian' || procMethod === 'unsharp') setParam1(1.0);
        else if (procMethod === 'tv_denoise') setParam1(10); // Iterations
        else setParam1(1.0);
        setCompleted(false);
    }, [procMethod]);

    // Auto-select Brush tool when Manual Drawing is selected
    useEffect(() => {
        if (mode === ToolCategory.Segmentation) {
            if (segMethod === 'manual_draw') {
                onSelectViewportTool?.('brush');
            } else if (viewportTool === 'brush' || viewportTool === 'eraser') {
                // If switching away from manual draw, reset to pointer if currently on brush
                onSelectViewportTool?.('wl');
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
            else alert("Invalid NIfTI file");
        } catch (err) {
            console.error(err);
            alert("Error reading reference volume");
        }
    };

    // --- SEGMENTATION ALGORITHMS ---

    const getHistogram = (data: any, min: number, max: number) => {
        const histogram = new Int32Array(256);
        const range = max - min || 1;
        const step = 256 / range;
        const len = data.length;
        const stride = len > 2_000_000 ? Math.floor(len / 500_000) : 1;
        
        for (let i = 0; i < len; i += stride) {
            const val = data[i];
            const bin = Math.floor((val - min) * step);
            if (bin >= 0 && bin < 256) histogram[bin]++;
        }
        return { histogram, step };
    };

    const computeOtsuThreshold = (histogram: Int32Array, total: number) => {
        let sum = 0;
        for (let i = 0; i < 256; i++) sum += i * histogram[i];

        let sumB = 0;
        let wB = 0;
        let wF = 0;
        let maxVar = 0;
        let threshold = 0;

        for (let t = 0; t < 256; t++) {
            wB += histogram[t];
            if (wB === 0) continue;
            wF = total - wB;
            if (wF === 0) break;

            sumB += t * histogram[t];
            const mB = sumB / wB;
            const mF = (sum - sumB) / wF;

            const varBetween = wB * wF * (mB - mF) * (mB - mF);
            if (varBetween > maxVar) {
                maxVar = varBetween;
                threshold = t;
            }
        }
        return threshold;
    };

    // Simplified Li's Method (Iterative Minimum Cross Entropy)
    const computeLiThreshold = (histogram: Int32Array, total: number) => {
        let mean = 0;
        for(let i=0; i<256; i++) mean += i * histogram[i];
        mean /= total;

        let threshold = Math.round(mean);
        let newThreshold = threshold;
        
        // Iterate (max 50 to prevent hang)
        for(let iter=0; iter<50; iter++) {
            let sumB = 0, wB = 0;
            let sumF = 0, wF = 0;

            for(let i=0; i<=threshold; i++) {
                wB += histogram[i];
                sumB += i * histogram[i];
            }
            for(let i=threshold+1; i<256; i++) {
                wF += histogram[i];
                sumF += i * histogram[i];
            }
            
            if (wB === 0 || wF === 0) break;

            const mB = sumB / wB;
            const mF = sumF / wF;
            
            // Li's formula approximation update
            const temp = (mF - mB) / (Math.log(mF) - Math.log(mB));
            newThreshold = Math.round(temp);
            
            if (newThreshold === threshold) break;
            threshold = newThreshold;
        }
        return threshold;
    };

    // --- PROCESSING PIPELINE ---

    const runProcessing = async () => {
        if (!volume || !onUpdateVolume) return;
        setIsProcessing(true);
        setCompleted(false);
        setProgress(0);
        await new Promise(resolve => setTimeout(resolve, 50)); // UI refresh

        try {
            const { data, min, max, dimensions } = volume;
            const [width, height, depth] = dimensions;
            const len = data.length;
            const newData = new Float32Array(len);
            
            // Initial Copy
            newData.set(data);

            const range = max - min || 1;

            const updateProgress = async (val: number) => {
                setProgress(val);
                await new Promise(r => setTimeout(r, 0));
            };
            
            if (procMethod === 'hist_eq') {
                const { histogram } = getHistogram(data, min, max);
                const cdf = new Int32Array(256);
                let sum = 0;
                for(let i=0; i<256; i++) { sum += histogram[i]; cdf[i] = sum; }
                const total = sum;
                
                const CHUNK_SIZE = 500000;
                for(let i=0; i<len; i+=CHUNK_SIZE) {
                    const end = Math.min(i+CHUNK_SIZE, len);
                    for(let j=i; j<end; j++) {
                        const bin = Math.floor(((data[j] - min) / range) * 255);
                        const normVal = cdf[Math.max(0, Math.min(255, bin))] / total;
                        newData[j] = min + normVal * range;
                    }
                    await updateProgress(Math.floor((i/len)*100));
                }
            } 
            else if (procMethod === 'clahe') {
                // Slice-wise Contrast Limited Histogram Equalization approximation
                const clipLimit = param1;
                for (let z=0; z<depth; z++) {
                    const offset = z * width * height;
                    const sliceEnd = offset + width * height;
                    const sliceData = data.subarray(offset, sliceEnd);
                    
                    let sMin = Infinity, sMax = -Infinity;
                    for(let k=0; k<sliceData.length; k++) {
                        if(sliceData[k] < sMin) sMin = sliceData[k];
                        if(sliceData[k] > sMax) sMax = sliceData[k];
                    }
                    const sRange = sMax - sMin || 1;
                    
                    const hist = new Int32Array(256);
                    for(let k=0; k<sliceData.length; k++) {
                        const bin = Math.floor(((sliceData[k] - sMin) / sRange) * 255);
                        hist[Math.max(0, Math.min(255, bin))]++;
                    }
                    
                    const limit = (sliceData.length / 256) * clipLimit;
                    let excess = 0;
                    for(let k=0; k<256; k++) {
                        if (hist[k] > limit) {
                            excess += hist[k] - limit;
                            hist[k] = limit;
                        }
                    }
                    const increment = excess / 256;
                    for(let k=0; k<256; k++) hist[k] += increment;
                    
                    const cdf = new Float32Array(256);
                    let sum = 0;
                    for(let k=0; k<256; k++) { sum += hist[k]; cdf[k] = sum / sliceData.length; }
                    
                    for(let k=0; k<sliceData.length; k++) {
                        const bin = Math.floor(((sliceData[k] - sMin) / sRange) * 255);
                        newData[offset + k] = sMin + cdf[Math.max(0, Math.min(255, bin))] * sRange;
                    }
                    if (z % 5 === 0) await updateProgress(Math.floor((z/depth)*100));
                }
            }
            else if (procMethod === 'gamma_bright' || procMethod === 'gamma_dark') {
                const gamma = param1; 
                for(let i=0; i<len; i+=500000) {
                    const end = Math.min(i+500000, len);
                    for(let j=i; j<end; j++) {
                        const norm = Math.max(0, (data[j] - min) / range);
                        newData[j] = min + Math.pow(norm, gamma) * range;
                    }
                    await updateProgress(Math.floor((i/len)*100));
                }
            }
            else if (procMethod === 'sigmoid') {
                const gain = param1; 
                const cutoff = param2; 
                for(let i=0; i<len; i+=500000) {
                    const end = Math.min(i+500000, len);
                    for(let j=i; j<end; j++) {
                        const u = (data[j] - min) / range;
                        const val = 1 / (1 + Math.exp(-gain * (u - cutoff)));
                        newData[j] = min + val * range;
                    }
                    await updateProgress(Math.floor((i/len)*100));
                }
            }
            else if (procMethod === 'gaussian') {
                // Separable 3-pass Box Blur approximation
                const buf = new Float32Array(len);
                buf.set(data);
                const k = [0.2, 0.6, 0.2]; 
                const idx = (x:number, y:number, z:number) => z*width*height + y*width + x;

                // X-pass
                for(let z=0; z<depth; z++) {
                    for(let y=0; y<height; y++) {
                        for(let x=1; x<width-1; x++) {
                            const i = idx(x,y,z);
                            newData[i] = buf[i-1]*k[0] + buf[i]*k[1] + buf[i+1]*k[2];
                        }
                    }
                    if (z % 10 === 0) await updateProgress(33 * (z/depth));
                }
                buf.set(newData);
                
                // Y-pass
                for(let z=0; z<depth; z++) {
                    for(let y=1; y<height-1; y++) {
                        for(let x=0; x<width; x++) {
                            const i = idx(x,y,z);
                            newData[i] = buf[i-width]*k[0] + buf[i]*k[1] + buf[i+width]*k[2];
                        }
                    }
                    if (z % 10 === 0) await updateProgress(33 + 33 * (z/depth));
                }
                buf.set(newData);

                // Z-pass
                const sliceSize = width * height;
                for(let z=1; z<depth-1; z++) {
                    for(let y=0; y<height; y++) {
                        for(let x=0; x<width; x++) {
                            const i = idx(x,y,z);
                            newData[i] = buf[i-sliceSize]*k[0] + buf[i]*k[1] + buf[i+sliceSize]*k[2];
                        }
                    }
                    if (z % 10 === 0) await updateProgress(66 + 33 * (z/depth));
                }
            }
            else if (procMethod === 'unsharp') {
                const strength = param1;
                // Simple blur first (box 1D average)
                const blurred = new Float32Array(len);
                const buf = new Float32Array(len);
                buf.set(data);
                
                for(let i=width+1; i<len-width-1; i++) {
                     blurred[i] = (buf[i-1] + buf[i] + buf[i+1] + buf[i-width] + buf[i+width]) / 5;
                }
                
                for(let i=0; i<len; i++) {
                    const mask = data[i] - blurred[i];
                    newData[i] = data[i] + strength * mask;
                    if (i % 500000 === 0) await updateProgress(Math.floor((i/len)*100));
                }
            }
            else if (procMethod === 'hist_match') {
                if (!referenceVolume) throw new Error("Reference volume missing");
                
                const { histogram: hSrc } = getHistogram(data, min, max);
                const cdfSrc = new Float32Array(256);
                let sumSrc = 0;
                for(let i=0; i<256; i++) { sumSrc += hSrc[i]; cdfSrc[i] = sumSrc; }
                for(let i=0; i<256; i++) cdfSrc[i] /= sumSrc;

                const { histogram: hRef } = getHistogram(referenceVolume.data, referenceVolume.min, referenceVolume.max);
                const cdfRef = new Float32Array(256);
                let sumRef = 0;
                for(let i=0; i<256; i++) { sumRef += hRef[i]; cdfRef[i] = sumRef; }
                for(let i=0; i<256; i++) cdfRef[i] /= sumRef;

                const mapping = new Float32Array(256);
                for(let i=0; i<256; i++) {
                    const srcVal = cdfSrc[i];
                    let closestIdx = 0, minDiff = 1;
                    for(let j=0; j<256; j++) {
                        const diff = Math.abs(cdfRef[j] - srcVal);
                        if(diff < minDiff) { minDiff = diff; closestIdx = j; }
                    }
                    mapping[i] = closestIdx;
                }

                const refRange = referenceVolume.max - referenceVolume.min || 1;
                for(let i=0; i<len; i++) {
                    const bin = Math.floor(((data[i] - min) / range) * 255);
                    const mappedBin = mapping[Math.max(0, Math.min(255, bin))];
                    newData[i] = referenceVolume.min + (mappedBin / 255) * refRange;
                    if (i % 500000 === 0) await updateProgress(Math.floor((i/len)*100));
                }
            }
            else if (procMethod === 'n4_bias') {
                // Pseudo N4 (Vignette Correction)
                for(let i=0; i<len; i++) {
                     const z = Math.floor(i / (width * height));
                     const rem = i % (width * height);
                     const y = Math.floor(rem / width);
                     const x = rem % width;
                     
                     const dx = (x - width/2) / (width/2);
                     const dy = (y - height/2) / (height/2);
                     const dz = (z - depth/2) / (depth/2);
                     
                     const distSq = dx*dx + dy*dy + dz*dz;
                     const bias = 1.0 - 0.3 * distSq; 
                     newData[i] = data[i] / Math.max(0.1, bias);
                }
                await updateProgress(100);
            }
            else if (procMethod === 'median_3d') {
                // 3x3 Median (Slice-wise)
                 for(let z=0; z<depth; z++) {
                    const offset = z * width * height;
                    const sliceData = data.subarray(offset, offset + width * height);
                    const outSlice = newData.subarray(offset, offset + width * height);
                    
                    for(let y=1; y<height-1; y++) {
                        for(let x=1; x<width-1; x++) {
                            const i = y*width + x;
                            const neighbors = [
                                sliceData[i-width-1], sliceData[i-width], sliceData[i-width+1],
                                sliceData[i-1],       sliceData[i],       sliceData[i+1],
                                sliceData[i+width-1], sliceData[i+width], sliceData[i+width+1]
                            ];
                            neighbors.sort((a,b)=>a-b);
                            outSlice[i] = neighbors[4];
                        }
                    }
                    if (z % 5 === 0) await updateProgress(Math.floor((z/depth)*100));
                }
            }

            // Recalculate Min/Max
            let newMin = Infinity, newMax = -Infinity;
            for(let i=0; i<len; i+=10) {
                if (newData[i] < newMin) newMin = newData[i];
                if (newData[i] > newMax) newMax = newData[i];
            }

            if (onUpdateVolume) {
                onUpdateVolume({
                    ...volume,
                    data: newData,
                    min: newMin,
                    max: newMax
                });
            }
            setCompleted(true);
            setProgress(100);

        } catch (e: any) {
            console.error(e);
            alert("Processing failed: " + (e.message || "Unknown error"));
        } finally {
            setIsProcessing(false);
        }
    };

    const runSegmentation = async () => {
        if (!volume || !onUpdateSegmentation) return;
        if (segMethod === 'manual_draw') {
            alert("Manual drawing is active. Use the Brush tool on the viewports.");
            return;
        }

        setIsProcessing(true);
        setCompleted(false);
        setProgress(0);

        await new Promise(resolve => setTimeout(resolve, 50));

        try {
            const { data, min, max } = volume;
            const len = data.length;
            const mask = new Uint8Array(len);
            
            let threshold = manualThreshold;
            let upperThreshold = manualUpper;
            let thresholdBin = 0;

            if (['otsu', 'li', 'multi_otsu'].includes(segMethod)) {
                const { histogram, step } = getHistogram(data, min, max);
                let total = 0;
                for(let i=0; i<256; i++) total += histogram[i];
                
                if (segMethod === 'otsu') {
                    thresholdBin = computeOtsuThreshold(histogram, total);
                    threshold = min + (thresholdBin / step);
                } else if (segMethod === 'li') {
                    thresholdBin = computeLiThreshold(histogram, total);
                    threshold = min + (thresholdBin / step);
                } else if (segMethod === 'multi_otsu') {
                    const t1Bin = computeOtsuThreshold(histogram, total);
                    
                    const hist2 = new Int32Array(256);
                    let total2 = 0;
                    for(let i=t1Bin; i<256; i++) {
                        hist2[i] = histogram[i];
                        total2 += histogram[i];
                    }
                    const t2Bin = computeOtsuThreshold(hist2, total2);
                    
                    threshold = min + (t1Bin / step);
                    upperThreshold = min + (Math.max(t1Bin+1, t2Bin) / step);
                }
            }

            const CHUNK_SIZE = 500000;
            
            for (let i = 0; i < len; i += CHUNK_SIZE) {
                const end = Math.min(i + CHUNK_SIZE, len);
                
                for (let j = i; j < end; j++) {
                    const val = data[j];
                    
                    if (segMethod === 'binary' || segMethod === 'truncate') {
                        if (val >= threshold) mask[j] = 1;
                    } 
                    else if (segMethod === 'binary_inv') {
                        if (val <= threshold) mask[j] = 1;
                    }
                    else if (segMethod === 'range_pass') {
                        if (val >= threshold && val <= upperThreshold) mask[j] = 1;
                    }
                    else if (segMethod === 'otsu' || segMethod === 'li') {
                         if (val >= threshold) mask[j] = 1;
                    }
                    else if (segMethod === 'multi_otsu') {
                        if (val >= threshold && val < upperThreshold) mask[j] = 1; // Class 1
                        else if (val >= upperThreshold) mask[j] = 2; // Class 2
                    }
                    else if (segMethod === 'local_adaptive') {
                        if (val >= threshold) mask[j] = 3;
                    }
                }
                
                const currentProgress = 10 + Math.floor(((i + CHUNK_SIZE) / len) * 80);
                setProgress(Math.min(90, currentProgress));
                await new Promise(resolve => setTimeout(resolve, 0));
            }

            const segVol: VolumeData = {
                header: { ...volume.header, datatypeCode: 2 },
                dimensions: [volume.dimensions[0], volume.dimensions[1], volume.dimensions[2]],
                min: 0,
                max: 255,
                data: mask
            };

            onUpdateSegmentation(segVol);
            setCompleted(true);
            setProgress(100);
        } catch (e) {
            console.error(e);
            alert("Segmentation failed");
        } finally {
            setIsProcessing(false);
        }
    };

    const fetchModels = async () => {
        if (!serverUrl) return;
        setIsFetchingModels(true);
        setModels([]);
        try {
            // Remove trailing slash if present for robustness
            const baseUrl = serverUrl.replace(/\/$/, '');
            const response = await fetch(`${baseUrl}/models`);
            
            if (!response.ok) {
                throw new Error(`Server returned ${response.status}`);
            }
            
            const data = await response.json();
            if (Array.isArray(data) && data.length > 0) {
                setModels(data);
                setSelectedModelId(data[0].id);
            } else if (Array.isArray(data) && data.length === 0) {
                alert("Connected, but no models found on server.");
            } else {
                throw new Error("Invalid response format. Expected JSON array.");
            }
        } catch (e: any) {
            console.error(e);
            alert(`Connection failed: ${e.message}. Ensure CORS is enabled on the server.`);
        } finally {
            setIsFetchingModels(false);
        }
    };

    const runBackendSegmentation = async () => {
        if (!volume || !onUpdateSegmentation || !selectedModelId) return;
        setIsProcessing(true);
        setProgress(10);
        
        try {
            const blob = new Blob([volume.data.buffer], { type: 'application/octet-stream' });
            const formData = new FormData();
            formData.append('file', blob, 'volume.raw');
            formData.append('dimensions', JSON.stringify(volume.dimensions));
            formData.append('model_id', selectedModelId);

            setProgress(30);

            const baseUrl = serverUrl.replace(/\/$/, '');
            const response = await fetch(`${baseUrl}/predict`, {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                throw new Error(`Server returned ${response.status}: ${response.statusText}`);
            }

            setProgress(60);

            const responseBuffer = await response.arrayBuffer();
            const segVol = parseNiftiFile(responseBuffer);

            if (segVol) {
                if (segVol.header.datatypeCode !== 2) {
                    const len = segVol.data.length;
                    const maskData = new Uint8Array(len);
                    for(let i=0; i<len; i++) maskData[i] = segVol.data[i];
                    segVol.data = maskData;
                    segVol.header.datatypeCode = 2;
                }
                
                onUpdateSegmentation(segVol);
                setCompleted(true);
                setProgress(100);
            } else {
                throw new Error("Failed to parse response as NIfTI");
            }

        } catch (e: any) {
            console.error(e);
            alert(`External Segmentation Failed: ${e.message}`);
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
                                <option value="clahe">1. T1-Optimized CLAHE (Adaptive)</option>
                                <option value="hist_match">2. Histogram Matching (Reference)</option>
                                <option value="hist_eq">3. Global Histogram Equalization</option>
                                <option value="gamma_bright">4. Gamma Correction (Brighten)</option>
                                <option value="gamma_dark">5. Gamma Correction (Darken)</option>
                                <option value="sigmoid">6. Sigmoid Contrast Stretch</option>
                            </optgroup>
                            <optgroup label="Filtering / Denoising">
                                <option value="unsharp">8. Unsharp Masking (Sharpen Edges)</option>
                                <option value="gaussian">10. Gaussian Smoothing (Reduce Noise)</option>
                                <option value="median_3d">11. 3D Median Filter (Edge-Preserving Noise)</option>
                            </optgroup>
                            <optgroup label="Bias Field Correction">
                                <option value="n4_bias">13. N4 Bias Field Correction (Approx)</option>
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

                 <button 
                    onClick={runProcessing}
                    disabled={isProcessing || !volume || (procMethod === 'hist_match' && !referenceVolume)}
                    className="mt-auto w-full py-3 bg-cyan-600 hover:bg-cyan-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-lg flex items-center justify-center gap-2 transition-colors shadow-lg"
                >
                    {isProcessing ? <Loader2 className="animate-spin w-4 h-4"/> : completed ? <Check className="w-4 h-4"/> : <Wand2 className="w-4 h-4" />}
                    {isProcessing ? `Running ${progress}%` : completed ? 'Complete' : 'Run Pipeline'}
                </button>
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
                                        <span>Brush Size</span>
                                        <span>{brushSize}px</span>
                                    </div>
                                    <input 
                                        type="range" min="1" max="50" 
                                        value={brushSize} 
                                        onChange={(e) => onBrushSizeChange?.(Number(e.target.value))}
                                        className="w-full h-1 bg-gray-700 rounded cursor-pointer accent-cyan-500"
                                    />
                                </div>
                                <div className="text-[10px] text-gray-400 italic flex items-start gap-1">
                                    <Hand className="w-3 h-3 shrink-0 mt-0.5" />
                                    Draw directly on the slice viewports.
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
                                    <div className="space-y-1">
                                        <label className="flex justify-between text-xs text-gray-400">
                                            <span>Kernel Size</span>
                                            <span className="font-mono">{localKernel}x{localKernel}</span>
                                        </label>
                                        <input 
                                            type="range" 
                                            min="3" max="21" step="2"
                                            value={localKernel}
                                            onChange={(e) => setLocalKernel(Number(e.target.value))}
                                            className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                                        />
                                    </div>
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
                        <button 
                            onClick={runSegmentation}
                            disabled={isProcessing || !volume}
                            className="w-full py-3 bg-cyan-600 hover:bg-cyan-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-lg flex items-center justify-center gap-2 transition-colors"
                        >
                            {isProcessing ? <Loader2 className="animate-spin w-4 h-4"/> : <Play className="w-4 h-4" />}
                            {isProcessing ? `Segmenting ${progress}%` : 'Generate Masks'}
                        </button>
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

                            {models.length > 0 && (
                                <div className="space-y-2 animate-in fade-in slide-in-from-top-2">
                                    <div className="relative">
                                        <select 
                                            value={selectedModelId}
                                            onChange={(e) => setSelectedModelId(e.target.value)}
                                            className="w-full bg-gray-800 border border-gray-700 text-gray-200 text-xs rounded p-2 appearance-none focus:ring-1 focus:ring-purple-500 focus:border-purple-500 outline-none pr-8"
                                        >
                                            {models.map(m => (
                                                <option key={m.id} value={m.id}>{m.name}</option>
                                            ))}
                                        </select>
                                        <div className="absolute inset-y-0 right-0 flex items-center px-2 pointer-events-none text-gray-400">
                                            <ChevronDown />
                                        </div>
                                    </div>
                                    
                                    {selectedModel && (
                                        <div className="bg-gray-800/50 p-2 rounded border border-gray-700/50 text-[10px] space-y-1">
                                            <div className="flex gap-1.5 items-start">
                                                <Info className="w-3 h-3 text-purple-400 shrink-0 mt-0.5" />
                                                <span className="text-gray-300 italic">{selectedModel.description}</span>
                                            </div>
                                            {selectedModel.goal && (
                                                <div className="text-gray-500 pl-4.5">Goal: {selectedModel.goal}</div>
                                            )}
                                            {selectedModel.input_shape && (
                                                <div className="text-gray-500 pl-4.5 font-mono">Input: {Array.isArray(selectedModel.input_shape) ? selectedModel.input_shape.join('x') : selectedModel.input_shape}</div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            )}

                            <button 
                                onClick={runBackendSegmentation}
                                disabled={isProcessing || !volume || !selectedModelId}
                                className="w-full py-2 bg-purple-900/40 border border-purple-800/50 hover:bg-purple-900/60 hover:border-purple-500 text-purple-300 text-xs rounded transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {isProcessing ? <Loader2 className="animate-spin w-3 h-3"/> : <Cpu className="w-3 h-3" />}
                                Run Inference
                            </button>
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
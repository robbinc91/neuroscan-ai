import React, { useState, useEffect, useRef, useMemo, useCallback, useImperativeHandle, forwardRef } from 'react';
import { ViewMode, VolumeData, ViewportHandle, ReportImages, ViewportTool, WindowLevel } from '../types';
import { Move, ZoomIn, Sun, Ruler, Rotate3d, Layers, Play, Pause, Maximize, Settings, Sliders, ChevronDown, ChevronUp, Ghost, PenTool, Eraser, Minimize, MousePointer2, RefreshCcw, Box, Trash2 } from 'lucide-react';
import { WL_PRESETS, applyWlPreset, formatWindowLevel, windowBounds, type WlPreset } from '../utils/windowLevel';
import {
    SliceMeasurement,
    SliceOrientation,
    axisLockPoint,
    displayedSliceIndex,
    formatLengthMm,
    inPlaneVoxelToDisplayUv,
    measurementLengthMm,
    pickSliceUv,
    sliceUvToVoxelIndex
} from '../utils/measure';
import { canvasToJpegDataUrl, captureWebglJpeg, pickSnapshotIndices } from '../utils/reportImages';
import { sliceFlipH, sliceSideLabels, type DisplayConvention } from '../utils/orientation';

interface ViewportProps {
    viewMode: ViewMode;
    onViewModeChange?: (mode: ViewMode) => void;
    volume: VolumeData | null;
    segmentation?: VolumeData | null;
    tool?: ViewportTool;
    onToolChange?: (tool: ViewportTool) => void;
    brushSize?: number;
    onUpdateSegmentation?: (vol: VolumeData | null) => void;
    position?: {x: number, y: number, z: number};
    onPositionChange?: (pos: {x: number, y: number, z: number}) => void;
    colormap?: 'grayscale' | 'hot-cold';
    opacity?: number;
    overlayVolume?: VolumeData | null;
    overlayOpacity?: number;
    overlayColormap?: 'grayscale' | 'hot-cold';
    windowLevel?: WindowLevel;
    onWindowLevelChange?: (wl: WindowLevel) => void;
    enableSliceKeys?: boolean;
    brushLabel?: number;
    onPaintStrokeStart?: () => void;
    onPaintHistoryChange?: (count: number) => void;
    displayConvention?: DisplayConvention;
    onDisplayConventionChange?: (c: DisplayConvention) => void;
    cinePlaying?: boolean;
    onCinePlayingChange?: (playing: boolean) => void;
}

interface SliceViewerProps {
    title: string;
    orientation: 'Axial' | 'Coronal' | 'Sagittal';
    color: string;
    isActive: boolean;
    volume: VolumeData | null;
    segmentation?: VolumeData | null;
    slice: number;
    maxSlice: number;
    onSliceChange: (slice: number) => void;
    onCrosshairChange: (u: number, v: number) => void;
    crosshair: { x: number, y: number };
    tool: ViewportTool;
    brushSize: number;
    brushLabel?: number;
    onDraw?: (x: number, y: number, z: number, val: number, radius: number) => void;
    onPaintStrokeStart?: () => void;
    flipH?: boolean;
    colormap?: 'grayscale' | 'hot-cold';
    opacity?: number;
    overlayVolume?: VolumeData | null;
    overlayOpacity?: number;
    overlayColormap?: 'grayscale' | 'hot-cold';
    onDoubleClickLayout?: () => void;
    measurements?: SliceMeasurement[];
    onCommitMeasurement?: (start: { u: number; v: number }, end: { u: number; v: number }) => void;
    windowLevel?: WindowLevel;
    onWindowLevelChange?: (wl: WindowLevel) => void;
    onActivate?: () => void;
}

interface Volume3DViewerProps {
    volume: VolumeData | null;
    segmentation?: VolumeData | null;
    crosshair: { x: number, y: number, z: number };
    onDoubleClickLayout?: () => void;
    windowLevel?: WindowLevel;
}

interface RenderSettings {
    mode: 0 | 1 | 2;
    threshold: number;
    opacity: number;
}

// --- CONSTANTS & HELPERS ---

const SEG_PALETTE = [
    [0, 0, 0],       // 0
    [239, 68, 68],   // 1: Red
    [34, 197, 94],   // 2: Green
    [59, 130, 246],  // 3: Blue
    [234, 179, 8],   // 4: Yellow
    [168, 85, 247],  // 5: Purple
    [236, 72, 153],  // 6: Pink
    [249, 115, 22],  // 7: Orange
    [6, 182, 212],   // 8: Cyan
    [163, 230, 53],  // 9: Lime
];

const DIFF_SEG_PALETTE = [
    [0, 0, 0],      // 0: None
    [239, 68, 68],  // 1: Disappeared (Red)
    [34, 197, 94],  // 2: New (Green)
    [255, 255, 255],// 3: Stable (White/Gray)
];

const PALETTE_LUT = new Uint8Array(256 * 3);
for (let i = 0; i < 256; i++) {
    const c = SEG_PALETTE[i % SEG_PALETTE.length];
    PALETTE_LUT[i * 3] = c[0];
    PALETTE_LUT[i * 3 + 1] = c[1];
    PALETTE_LUT[i * 3 + 2] = c[2];
}

export const generateSliceBitmap = (
    volume: VolumeData, 
    segmentation: VolumeData | null, 
    orientation: string, 
    slice: number,
    colormap: 'grayscale' | 'hot-cold' = 'grayscale',
    opacity: number = 1.0,
    windowLevel?: WindowLevel,
    flipH = false
): HTMLCanvasElement | null => {
    if (!volume) return null;
    
    const { data, dimensions, min, max } = volume;
    const [dimX, dimY, dimZ] = dimensions;
    const sliceIdx = Math.floor(slice);

    let width = 0, height = 0;
    let xStride = 0, yStride = 0, origin = 0;

    // Axial Y is flipped so display v=0 is the high-Y edge (see sliceUvToVoxelIndex).
    if (orientation === 'Axial') {
        width = dimX;
        height = dimY;
        origin = sliceIdx * (dimX * dimY) + (dimY - 1) * dimX;
        xStride = 1; yStride = -dimX;  
    } else if (orientation === 'Coronal') {
        width = dimX;
        height = dimZ;
        origin = sliceIdx * dimX;
        xStride = 1; yStride = dimX * dimY; 
    } else if (orientation === 'Sagittal') {
        width = dimY;
        height = dimZ;
        origin = sliceIdx;
        xStride = dimX; yStride = dimX * dimY; 
    }

    if (flipH && width > 1) {
        origin += (width - 1) * xStride;
        xStride = -xStride;
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const imgData = ctx.createImageData(width, height);
    const buf32 = new Uint32Array(imgData.data.buffer);
    let scale = 1, offset = 0;
    
    if (colormap === 'hot-cold') {
        const absMax = Math.max(Math.abs(min), Math.abs(max)) || 1;
        scale = 127 / absMax;
    } else if (windowLevel) {
        const { lo, hi } = windowBounds(windowLevel);
        offset = lo;
        scale = 255 / (hi - lo || 1);
    } else {
        const range = (max - min) || 1;
        scale = 255 / range;
        offset = min;
    }
    
    const segData = segmentation ? segmentation.data : null;
    const useDiffPalette = colormap === 'hot-cold' && segmentation && segmentation.max <= 3 && segmentation.max > 0;
    let currentVolIdxRow = origin;
    let pixelIdx = 0;
    const BLEND_BG = 154, BLEND_FG = 102;
    
    for (let v = 0; v < height; v++) {
        let volIdx = currentVolIdxRow;
        for (let u = 0; u < width; u++) {
            let r=0, g=0, b=0;
            if (colormap === 'hot-cold') {
                const rawVal = data[volIdx];
                if (rawVal > 0) {
                    r = Math.min(255, rawVal * scale * 2); 
                    if (r > 200) g = (r - 200) * 2;
                } else if (rawVal < 0) {
                    b = Math.min(255, -rawVal * scale * 2);
                    if (b > 200) g = (b - 200) * 2;
                }
            } else {
                let val = (data[volIdx] - offset) * scale;
                if (val > 255) val = 255; else if (val < 0) val = 0;
                r = val; g = val; b = val;
            }

            const segVal = segData ? segData[volIdx] : 0;
            if (segVal > 0) {
                let rOv = 0, gOv = 0, bOv = 0;
                if (useDiffPalette) {
                   const c = DIFF_SEG_PALETTE[segVal] || [255,255,255];
                   rOv = c[0]; gOv = c[1]; bOv = c[2];
                } else {
                   const lutIdx = segVal * 3;
                   rOv = PALETTE_LUT[lutIdx];
                   gOv = PALETTE_LUT[lutIdx + 1];
                   bOv = PALETTE_LUT[lutIdx + 2];
                }
                r = (r * BLEND_BG + rOv * BLEND_FG) >> 8;
                g = (g * BLEND_BG + gOv * BLEND_FG) >> 8;
                b = (b * BLEND_BG + bOv * BLEND_FG) >> 8;
            }
            buf32[pixelIdx++] = 0xFF000000 | (b << 16) | (g << 8) | r;
            volIdx += xStride;
        }
        currentVolIdxRow += yStride;
    }
    ctx.putImageData(imgData, 0, 0);
    return canvas;
};

// --- WEBGL UTILS ---

const compileShader = (gl: WebGL2RenderingContext, type: number, source: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.error(gl.getShaderInfoLog(s));
        gl.deleteShader(s);
        return null;
    }
    return s;
};

const create3DTexture = (gl: WebGL2RenderingContext, volume: VolumeData, isSeg: boolean = false) => {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, tex);
    
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, isSeg ? gl.NEAREST : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, isSeg ? gl.NEAREST : gl.LINEAR);

    const { data, dimensions } = volume;
    const [w, h, d] = dimensions;
    
    // Performance Optimization: Upload raw float data instead of normalizing on CPU
    let uploadData;
    if (isSeg) {
         uploadData = new Uint8Array(data); // Seg is usually small integers
    } else {
         uploadData = data instanceof Float32Array ? data : new Float32Array(data);
    }

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    
    if (isSeg) {
        // Segmentation -> R8UI or R8 (normalized) - usually R8 is easier to sample in shader as 0..1
         gl.texImage3D(
            gl.TEXTURE_3D, 0, gl.R8, 
            w, h, d, 0, 
            gl.RED, gl.UNSIGNED_BYTE, uploadData
        );
    } else {
        // Volume -> R32F (High Precision Float)
        gl.texImage3D(
            gl.TEXTURE_3D, 0, gl.R32F, 
            w, h, d, 0, 
            gl.RED, gl.FLOAT, uploadData
        );
    }

    return tex;
};


// --- WEBGL SHADERS ---

// Raycasting Vertex Shader
const VS_RAYCAST = `#version 300 es
layout(location=0) in vec2 a_position;
out vec2 v_uv;
void main() {
    v_uv = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

// Raycasting Fragment Shader
const FS_RAYCAST = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler3D;

in vec2 v_uv;
uniform sampler3D u_volume;
uniform mediump sampler3D u_segmentation;
uniform vec3 u_dims;
uniform mat4 u_invViewRot;
uniform float u_zoom;
uniform vec2 u_pan;
uniform float u_opacity;
uniform float u_threshold;
uniform int u_mode; // 0: Scatter, 1: MIP, 2: Surface
uniform bool u_hasSeg;
uniform vec3 u_lightDir;
uniform float u_stepSize; // Dynamic step size for performance
uniform vec3 u_boxSize;   // Physical aspect ratio box size
uniform vec2 u_dataRange; // Min/Max for windowing

out vec4 outColor;

const int MAX_STEPS = 512; 

// Intersect box centered at 0 with size u_boxSize
vec2 intersectBox(vec3 orig, vec3 dir) {
    vec3 boxMin = -u_boxSize * 0.5;
    vec3 boxMax = u_boxSize * 0.5;
    vec3 invDir = 1.0 / dir;
    vec3 tmin0 = (boxMin - orig) * invDir;
    vec3 tmax0 = (boxMax - orig) * invDir;
    vec3 tmin = min(tmin0, tmax0);
    vec3 tmax = max(tmin0, tmax0);
    float t0 = max(tmin.x, max(tmin.y, tmin.z));
    float t1 = min(tmax.x, min(tmax.y, tmax.z));
    return vec2(t0, t1);
}

// Calculate normal using gradients on the raw data
vec3 getNormal(vec3 p, vec3 texCoord) {
    // Epsilon in texture space
    vec3 eps = vec3(1.0) / u_dims; 
    
    // Sample raw values
    float dx = texture(u_volume, texCoord + vec3(eps.x, 0, 0)).r - texture(u_volume, texCoord - vec3(eps.x, 0, 0)).r;
    float dy = texture(u_volume, texCoord + vec3(0, eps.y, 0)).r - texture(u_volume, texCoord - vec3(0, eps.y, 0)).r;
    float dz = texture(u_volume, texCoord + vec3(0, 0, eps.z)).r - texture(u_volume, texCoord - vec3(0, 0, eps.z)).r;
    
    return normalize(vec3(-dx, -dy, -dz));
}

vec3 getSegColor(float val) {
    // Val is 0..1 from R8 texture, so * 255 to get integer ID
    int idx = int(val * 255.0 + 0.5);
    
    if (idx == 1) return vec3(0.937, 0.267, 0.267); // Red
    if (idx == 2) return vec3(0.133, 0.773, 0.369); // Green
    if (idx == 3) return vec3(0.231, 0.510, 0.965); // Blue
    if (idx == 4) return vec3(0.918, 0.702, 0.031); // Yellow
    if (idx == 5) return vec3(0.659, 0.333, 0.969); // Purple
    if (idx == 6) return vec3(0.925, 0.282, 0.600); // Pink
    if (idx == 7) return vec3(0.976, 0.451, 0.086); // Orange
    if (idx == 8) return vec3(0.024, 0.714, 0.831); // Cyan

    float hue = float(idx) * 0.618033988749895;
    hue = fract(hue);
    float s = 0.7 + fract(float(idx)*0.1) * 0.3;
    float v = 0.9;
    
    vec3 c = vec3(hue, s, v);
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

void main() {
    vec2 p = v_uv * 2.0 - 1.0;
    
    // Camera Setup
    // Ro is slightly pulled back. Box is centered at 0.
    vec3 ro = vec3((p.x / u_zoom) - u_pan.x, (p.y / u_zoom) + u_pan.y, -2.0);
    vec3 rd = vec3(0.0, 0.0, 1.0);

    vec3 ro_world = (u_invViewRot * vec4(ro, 1.0)).xyz;
    vec3 rd_world = mat3(u_invViewRot) * rd;

    vec2 t_hit = intersectBox(ro_world, rd_world);
    if (t_hit.x > t_hit.y) discard;
    
    float t = max(t_hit.x, 0.0);
    
    vec4 acc = vec4(0.0);
    float maxVal = 0.0;
    
    for(int i=0; i<MAX_STEPS; i++) {
        if (t > t_hit.y || acc.a >= 0.95) break;

        vec3 pos = ro_world + t * rd_world;
        
        // Map Physical Box Position to 0..1 Texture Space
        // pos is -boxSize/2 .. boxSize/2
        // texCoord = (pos / u_boxSize) + 0.5
        vec3 texCoord = (pos / u_boxSize) + 0.5;

        // Ensure we don't sample outside (clamp handled by texture params usually, but safe guard)
        if(any(lessThan(texCoord, vec3(0.0))) || any(greaterThan(texCoord, vec3(1.0)))) {
             t += u_stepSize; continue; 
        }

        // Fetch raw value
        float rawVal = texture(u_volume, texCoord).r;
        
        // Normalize on the fly
        float rangeDen = max(u_dataRange.y - u_dataRange.x, 1e-6);
        float val = (rawVal - u_dataRange.x) / rangeDen;
        
        float seg = 0.0;
        if (u_hasSeg) seg = texture(u_segmentation, texCoord).r;

        if (u_mode == 2) {
            if (seg > 0.001) {
                vec3 col = getSegColor(seg);
                vec3 normal = getNormal(pos, texCoord);
                // Simple lighting
                if (length(normal) < 0.1) normal = -rd_world; 
                float diffuse = max(dot(normal, u_lightDir), 0.2);
                float specular = pow(max(dot(reflect(-u_lightDir, normal), -rd_world), 0.0), 16.0);
                vec3 finalCol = col * (diffuse + 0.3) + vec3(0.5) * specular;
                acc.rgb = finalCol;
                acc.a = 1.0;
                break; 
            }
        } else if (u_mode == 0) {
            if (val > (u_threshold / 255.0)) {
                float alpha = (val - (u_threshold/255.0)) * u_opacity * 5.0;
                alpha = alpha * (u_stepSize / 0.004); 
                vec3 col = vec3(val);
                acc.rgb += (1.0 - acc.a) * col * alpha;
                acc.a += (1.0 - acc.a) * alpha;
            }
        } else if (u_mode == 1) {
            maxVal = max(maxVal, val);
        }

        t += u_stepSize;
    }

    if (u_mode == 1) {
        if (maxVal < (u_threshold/255.0)) discard;
        outColor = vec4(vec3(maxVal), 1.0);
    } else {
        if (acc.a < 0.01) discard;
        outColor = acc;
    }
}
`;

function drawRuler(
    ctx: CanvasRenderingContext2D,
    start: { u: number; v: number },
    end: { u: number; v: number },
    label: string,
    stroke: string
) {
    ctx.save();
    ctx.strokeStyle = stroke;
    ctx.fillStyle = stroke;
    ctx.lineWidth = 1.25;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(start.u + 0.5, start.v + 0.5);
    ctx.lineTo(end.u + 0.5, end.v + 0.5);
    ctx.stroke();
    for (const p of [start, end]) {
        ctx.beginPath();
        ctx.arc(p.u + 0.5, p.v + 0.5, 2.2, 0, Math.PI * 2);
        ctx.fill();
    }
    const mx = (start.u + end.u) / 2 + 4;
    const my = (start.v + end.v) / 2 - 4;
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.strokeText(label, mx, my);
    ctx.fillStyle = stroke;
    ctx.fillText(label, mx, my);
    ctx.restore();
}

const SliceViewer: React.FC<SliceViewerProps> = ({ 
    title, orientation, color, isActive, 
    volume, segmentation, 
    slice, maxSlice, onSliceChange, 
    onCrosshairChange, crosshair, 
    tool, brushSize, brushLabel = 1, onDraw, onPaintStrokeStart,
    colormap, opacity, overlayVolume, overlayOpacity, overlayColormap,
    onDoubleClickLayout, measurements, onCommitMeasurement,
    windowLevel, onWindowLevelChange, onActivate, flipH = false
}) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const baseCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const [isDragging, setIsDragging] = useState(false);
    const [draft, setDraft] = useState<{ start: { u: number; v: number }; end: { u: number; v: number } } | null>(null);
    const draftRef = useRef<{ start: { u: number; v: number }; end: { u: number; v: number } } | null>(null);
    const [zoom, setZoom] = useState(1);
    const [pan, setPan] = useState({ x: 0, y: 0 });
    const [fit, setFit] = useState(1);
    const panDragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
    const zoomDragRef = useRef<{ y: number; zoom: number } | null>(null);
    const dimKey = volume ? volume.dimensions.join('x') : '';
    useEffect(() => {
        setZoom(1);
        setPan({ x: 0, y: 0 });
    }, [dimKey]);

    useEffect(() => {
        if (!volume) {
            baseCanvasRef.current = null;
            return;
        }
        const baseBitmap = generateSliceBitmap(volume, segmentation, orientation, slice, colormap, opacity, windowLevel, flipH);
        if (!baseBitmap) {
            baseCanvasRef.current = null;
            return;
        }
        if (overlayVolume) {
            const overlayBitmap = generateSliceBitmap(
                overlayVolume, null, orientation, slice, overlayColormap || 'hot-cold', overlayOpacity,
                overlayColormap === 'grayscale' ? windowLevel : undefined,
                flipH
            );
            if (overlayBitmap) {
                const bctx = baseBitmap.getContext('2d');
                if (bctx) {
                    bctx.globalAlpha = overlayOpacity || 0.5;
                    bctx.drawImage(overlayBitmap, 0, 0);
                    bctx.globalAlpha = 1.0;
                }
            }
        }
        baseCanvasRef.current = baseBitmap;
    }, [volume, segmentation, orientation, slice, colormap, opacity, overlayVolume, overlayOpacity, overlayColormap, windowLevel, flipH]);

    useEffect(() => {
        const canvas = canvasRef.current;
        const base = baseCanvasRef.current;
        if (!canvas || !volume || !base) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        if (canvas.width !== base.width || canvas.height !== base.height) {
            canvas.width = base.width;
            canvas.height = base.height;
        }
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(base, 0, 0);

        if (isActive && tool !== 'measure') {
            const disp = inPlaneVoxelToDisplayUv(orientation, crosshair.x, crosshair.y, volume.dimensions, flipH);
            ctx.strokeStyle = color;
            ctx.lineWidth = 0.5;
            ctx.beginPath();
            ctx.moveTo(disp.u + 0.5, 0);
            ctx.lineTo(disp.u + 0.5, canvas.height);
            ctx.moveTo(0, disp.v + 0.5);
            ctx.lineTo(canvas.width, disp.v + 0.5);
            ctx.stroke();
        }

        const sliceIdx = displayedSliceIndex(slice);
        const visible = (measurements ?? []).filter(
            (m) => m.orientation === orientation && m.slice === sliceIdx
        );
        for (const m of visible) {
            const mm = measurementLengthMm(volume, orientation, sliceIdx, m.start, m.end, flipH);
            drawRuler(ctx, m.start, m.end, formatLengthMm(mm), '#22d3ee');
        }
        if (draft) {
            const mm = measurementLengthMm(volume, orientation, sliceIdx, draft.start, draft.end, flipH);
            drawRuler(ctx, draft.start, draft.end, formatLengthMm(mm), '#fde047');
        }
    }, [volume, orientation, slice, crosshair, isActive, color, tool, measurements, draft, segmentation, colormap, opacity, overlayVolume, overlayOpacity, overlayColormap, windowLevel, flipH]);

    useEffect(() => {
        if (tool !== 'measure') {
            draftRef.current = null;
            setDraft(null);
        }
    }, [tool]);

    const cancelMeasure = () => {
        draftRef.current = null;
        setDraft(null);
        setIsDragging(false);
    };

    useEffect(() => {
        if (!draft) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') cancelMeasure();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [draft]);

    const hitFromEvent = (e: { clientX: number; clientY: number }, clamp = false) => {
        const canvas = canvasRef.current;
        if (!canvas || !volume) return null;
        return pickSliceUv(canvas, e.clientX, e.clientY, { clamp });
    };

    const emitCrosshairFromDisplay = (u: number, v: number) => {
        if (!volume) return;
        const [vx, vy, vz] = sliceUvToVoxelIndex(orientation, u, v, slice, volume.dimensions, flipH);
        if (orientation === 'Axial') onCrosshairChange(vx, vy);
        else if (orientation === 'Coronal') onCrosshairChange(vx, vz);
        else onCrosshairChange(vy, vz);
    };

    useEffect(() => {
        const el = containerRef.current;
        const canvas = canvasRef.current;
        if (!el || !canvas || canvas.width < 1) return;
        const update = () => {
            const cw = el.clientWidth;
            const ch = el.clientHeight;
            if (cw < 1 || ch < 1) return;
            setFit(Math.min(cw / canvas.width, ch / canvas.height));
        };
        update();
        const ro = new ResizeObserver(update);
        ro.observe(el);
        return () => ro.disconnect();
    }, [volume, orientation, slice]);

    const finishMeasure = (e?: { clientX: number; clientY: number; shiftKey?: boolean }) => {
        const current = draftRef.current;
        if (!current) {
            setIsDragging(false);
            return;
        }
        const rawEnd = e ? hitFromEvent(e, true) ?? current.end : current.end;
        const end = axisLockPoint(current.start, rawEnd, !!e?.shiftKey);
        const dx = end.u - current.start.u;
        const dy = end.v - current.start.v;
        draftRef.current = null;
        setDraft(null);
        setIsDragging(false);
        if (dx * dx + dy * dy >= 1) {
            onCommitMeasurement?.(current.start, end);
        }
    };

    const wlDragRef = useRef<{
        x: number;
        y: number;
        width: number;
        center: number;
        moved: boolean;
    } | null>(null);

    const startWlDrag = (e: React.PointerEvent<HTMLCanvasElement>) => {
        if (!windowLevel || !onWindowLevelChange) return false;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        wlDragRef.current = {
            x: e.clientX,
            y: e.clientY,
            width: windowLevel.width,
            center: windowLevel.center,
            moved: false
        };
        return true;
    };

    const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
        onActivate?.();
        if (e.button === 1 || (tool === 'pan' && e.button === 0)) {
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            panDragRef.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
            return;
        }
        if (tool === 'zoom' && e.button === 0) {
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            zoomDragRef.current = { y: e.clientY, zoom };
            return;
        }
        const rightOrMiddle = e.button === 2;
        if (tool !== 'measure' && rightOrMiddle && startWlDrag(e)) return;
        if (tool === 'wl' && e.button === 0 && startWlDrag(e)) return;
        if (tool !== 'measure') return;
        if (e.button === 2) {
            e.preventDefault();
            cancelMeasure();
            return;
        }
        if (e.button !== 0) return;
        const hit = hitFromEvent(e);
        if (!hit) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        const next = { start: hit, end: hit };
        draftRef.current = next;
        setDraft(next);
        setIsDragging(true);
    };

    const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
        const panDrag = panDragRef.current;
        if (panDrag) {
            setPan({ x: panDrag.panX + (e.clientX - panDrag.x), y: panDrag.panY + (e.clientY - panDrag.y) });
            return;
        }
        const zDrag = zoomDragRef.current;
        if (zDrag) {
            const next = Math.max(0.5, Math.min(16, zDrag.zoom * Math.exp(-(e.clientY - zDrag.y) * 0.01)));
            setZoom(next);
            return;
        }
        const wlDrag = wlDragRef.current;
        if (wlDrag && windowLevel && onWindowLevelChange && volume) {
            const dx = e.clientX - wlDrag.x;
            const dy = e.clientY - wlDrag.y;
            if (Math.abs(dx) + Math.abs(dy) <= 4) return;
            wlDrag.moved = true;
            const span = Math.max(1e-3, volume.max - volume.min);
            const k = Math.max(span / 500, wlDrag.width / 400);
            onWindowLevelChange({
                width: Math.max(1e-3, wlDrag.width + dx * k * 1.4),
                center: wlDrag.center - dy * k
            });
            return;
        }
        if (tool !== 'measure') return;
        const prev = draftRef.current;
        if (!prev) return;
        const hit = hitFromEvent(e, true);
        if (!hit) return;
        const end = axisLockPoint(prev.start, hit, e.shiftKey);
        const next = { start: prev.start, end };
        draftRef.current = next;
        setDraft(next);
    };

    const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
        if (panDragRef.current || zoomDragRef.current) {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                e.currentTarget.releasePointerCapture(e.pointerId);
            }
            panDragRef.current = null;
            zoomDragRef.current = null;
            return;
        }
        const wlDrag = wlDragRef.current;
        if (wlDrag) {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                e.currentTarget.releasePointerCapture(e.pointerId);
            }
            if (!wlDrag.moved && e.button === 0) {
                const hit = hitFromEvent(e);
                if (hit) emitCrosshairFromDisplay(hit.u, hit.v);
            }
            wlDragRef.current = null;
            return;
        }
        if (tool !== 'measure') return;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
        }
        finishMeasure(e);
    };

    const handleMouseDown = (e: React.MouseEvent) => {
        if (e.button !== 0) return;
        if (tool === 'measure' || tool === 'wl' || tool === 'pan' || tool === 'zoom') return;
        onActivate?.();
        if (tool === 'brush' || tool === 'eraser') onPaintStrokeStart?.();
        setIsDragging(true);
        handleMouseMove(e);
    };

    const handleMouseUp = () => {
        if (tool === 'measure') return;
        setIsDragging(false);
    };
    
    const handleMouseMove = (e: React.MouseEvent) => {
        if (tool === 'measure') return;
        if (!isDragging && e.buttons !== 1) return;
        const hit = hitFromEvent(e);
        if (!hit || !volume) return;
        const [vx, vy, vz] = sliceUvToVoxelIndex(orientation, hit.u, hit.v, slice, volume.dimensions, flipH);

        if (tool === 'brush' || tool === 'eraser') {
            onDraw?.(vx, vy, vz, tool === 'brush' ? brushLabel : 0, brushSize);
        } else {
            emitCrosshairFromDisplay(hit.u, hit.v);
        }
    };

    const handleWheel = (e: React.WheelEvent) => {
        if (draft) return;
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
            const factor = e.deltaY > 0 ? 0.9 : 1.1;
            setZoom((z) => Math.max(0.5, Math.min(16, z * factor)));
            return;
        }
        if (e.deltaY !== 0) {
            const step = e.shiftKey ? 10 : 1;
            const delta = e.deltaY > 0 ? step : -step;
            const newSlice = Math.max(0, Math.min(maxSlice - 1, slice + delta));
            onSliceChange(newSlice);
        }
    };

    const labels = sliceSideLabels(orientation, volume, flipH);
    const cursor =
        tool === 'pan' ? 'cursor-move'
        : tool === 'zoom' ? 'cursor-ns-resize'
        : tool === 'measure' || tool === 'crosshair' ? 'cursor-crosshair'
        : tool === 'wl' ? 'cursor-ns-resize'
        : tool === 'brush' || tool === 'eraser' ? 'cursor-crosshair'
        : 'cursor-default';

    return (
        <div
            ref={containerRef}
            className={`relative w-full h-full bg-black border-2 ${isActive ? `border-[${color}]` : 'border-gray-800'} overflow-hidden flex flex-col`}
            onMouseEnter={onActivate}
        >
             <div className="absolute top-2 left-2 text-xs font-bold pointer-events-none z-10" style={{ color }}>
                {title} <span className="text-gray-500 font-mono">[{slice + 1}/{maxSlice}]</span>
             </div>
            {tool === 'measure' && volume && (
                <div className="absolute top-2 right-2 text-[10px] font-mono text-cyan-300/90 pointer-events-none z-10">
                    {draft
                        ? formatLengthMm(measurementLengthMm(volume, orientation, displayedSliceIndex(slice), draft.start, draft.end, flipH))
                        : 'Drag · Shift axis-lock'}
                </div>
            )}
            {labels.left && (
                <div className="absolute left-1 top-1/2 -translate-y-1/2 z-10 pointer-events-none text-[11px] font-bold text-amber-300/90">
                    {labels.left}
                </div>
            )}
            {labels.right && (
                <div className="absolute right-1 top-1/2 -translate-y-1/2 z-10 pointer-events-none text-[11px] font-bold text-amber-300/90">
                    {labels.right}
                </div>
            )}
            {labels.top && (
                <div className="absolute top-6 left-1/2 -translate-x-1/2 z-10 pointer-events-none text-[11px] font-bold text-amber-300/90">
                    {labels.top}
                </div>
            )}
            {labels.bottom && (
                <div className="absolute bottom-1 left-1/2 -translate-x-1/2 z-10 pointer-events-none text-[11px] font-bold text-amber-300/90">
                    {labels.bottom}
                </div>
            )}
            <div className="absolute inset-0 overflow-hidden flex items-center justify-center">
                <canvas
                    ref={canvasRef}
                    className={`touch-none ${cursor}`}
                    style={{
                        transform: `translate(${pan.x}px, ${pan.y}px) scale(${fit * zoom})`,
                        transformOrigin: 'center center'
                    }}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    onPointerCancel={handlePointerUp}
                    onContextMenu={(e) => {
                        e.preventDefault();
                        if (tool === 'measure') cancelMeasure();
                    }}
                    onMouseDown={handleMouseDown}
                    onMouseMove={handleMouseMove}
                    onMouseUp={handleMouseUp}
                    onMouseLeave={() => handleMouseUp()}
                    onWheel={handleWheel}
                    onDoubleClick={tool === 'measure' || tool === 'pan' || tool === 'zoom' ? (e) => {
                        e.stopPropagation();
                        if (tool === 'pan' || tool === 'zoom') {
                            setZoom(1);
                            setPan({ x: 0, y: 0 });
                        }
                    } : onDoubleClickLayout}
                    title={
                        tool === 'measure'
                            ? 'Drag to measure (patient mm). Shift locks to an axis.'
                            : tool === 'wl'
                                ? 'Drag: window/level. Click: crosshair. Ctrl+wheel: zoom.'
                                : tool === 'pan'
                                    ? 'Drag to pan. Double-click: fit. Ctrl+wheel: zoom.'
                                    : tool === 'zoom'
                                        ? 'Drag up/down to zoom. Double-click: fit. Ctrl+wheel: zoom.'
                                        : 'Click/drag: crosshair. Middle-drag: pan. Ctrl+wheel: zoom. Right-drag: W/L.'
                    }
                />
            </div>
        </div>
    );
};

const Volume3DViewer = React.memo(forwardRef<HTMLCanvasElement, Volume3DViewerProps>(({ volume, segmentation, crosshair, onDoubleClickLayout, windowLevel }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const setCanvasRef = useCallback(
        (el: HTMLCanvasElement | null) => {
            canvasRef.current = el;
            if (typeof ref === 'function') (ref as (node: HTMLCanvasElement | null) => void)(el);
            else if (ref && typeof ref === 'object' && 'current' in ref) {
                (ref as React.MutableRefObject<HTMLCanvasElement | null>).current = el;
            }
        },
        [ref]
    );
    const containerRef = useRef<HTMLDivElement>(null);
    
    // View State
    const [rotationUi, setRotationUi] = useState({ az: 45, el: 20 });
    const [zoomUi, setZoomUi] = useState(1.0);
    const [panUi, setPanUi] = useState({ x: 0, y: 0 });
    const [autoRotate, setAutoRotate] = useState(false);
    const rotationRef = useRef({ az: 45, el: 20 });
    const zoomRef = useRef(1.0);
    const panRef = useRef({ x: 0, y: 0 });
    const autoRotateRef = useRef(false);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    
    // Interaction State
    const isInteracting = useRef(false);
    const [isInteractingUi, setIsInteractingUi] = useState(false);
    const interactionTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Render Mode Settings
    const [settings, setSettings] = useState<RenderSettings>({
        mode: 0 as 0 | 1 | 2, 
        threshold: 40,
        opacity: 0.8
    });
    const settingsRef = useRef<RenderSettings>({ mode: 0, threshold: 40, opacity: 0.8 });
    const wlRef = useRef<WindowLevel | undefined>(windowLevel);
    wlRef.current = windowLevel;
    const [windowing, setWindowing] = useState({ p10: 40, p35: 100, p60: 150 });

    const isDraggingRef = useRef(false);
    const dragTypeRef = useRef<'rotate' | 'pan' | 'zoom'>('rotate');
    const lastMouseRef = useRef({ x: 0, y: 0 });
    const dragCleanupRef = useRef<(() => void) | null>(null);

    const glRef = useRef<WebGL2RenderingContext | null>(null);
    const programRef = useRef<WebGLProgram | null>(null);
    const volTexRef = useRef<WebGLTexture | null>(null);
    const segTexRef = useRef<WebGLTexture | null>(null);
    const vaoRef = useRef<WebGLVertexArrayObject | null>(null);

    const syncUiFromRefs = useCallback(() => {
        setRotationUi({ ...rotationRef.current });
        setZoomUi(zoomRef.current);
        setPanUi({ ...panRef.current });
    }, []);

    const updateSettings = useCallback((next: RenderSettings) => {
        settingsRef.current = next;
        setSettings(next);
    }, []);

    // Initialize WebGL
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        
        const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: true });
        if (!gl) return;
        glRef.current = gl;
        
        // Try to enable Float texture linear filtering for smooth 3D
        gl.getExtension('OES_texture_float_linear');
        gl.getExtension('EXT_color_buffer_float');

        const vs = compileShader(gl, gl.VERTEX_SHADER, VS_RAYCAST);
        const fs = compileShader(gl, gl.FRAGMENT_SHADER, FS_RAYCAST);
        if (!vs || !fs) return;
        
        const prog = gl.createProgram()!;
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.linkProgram(prog);
        programRef.current = prog;

        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        vaoRef.current = vao;
    }, []);

    useEffect(() => {
        autoRotateRef.current = autoRotate;
    }, [autoRotate]);

    // Load Textures
    useEffect(() => {
        const gl = glRef.current;
        if (!gl || !volume) return;
        if (volTexRef.current) gl.deleteTexture(volTexRef.current);
        volTexRef.current = create3DTexture(gl, volume, false);

        // Fast approximate percentiles using downsampled intensity values.
        const sample: number[] = [];
        const volData = volume.data;
        const stride = Math.max(1, Math.floor(volData.length / 20000));
        for (let i = 0; i < volData.length; i += stride) {
            sample.push(Number(volData[i]));
        }
        sample.sort((a, b) => a - b);
        const at = (q: number) => sample[Math.max(0, Math.min(sample.length - 1, Math.floor(q * (sample.length - 1))))];
        const p10Raw = at(0.1);
        const p35Raw = at(0.35);
        const p60Raw = at(0.6);
        const range = Math.max(volume.max - volume.min, 1e-6);
        const toThreshold = (val: number) => Math.round(Math.max(0, Math.min(255, ((val - volume.min) / range) * 255)));
        const nextWindowing = {
            p10: toThreshold(p10Raw),
            p35: toThreshold(p35Raw),
            p60: toThreshold(p60Raw)
        };
        setWindowing(nextWindowing);
        const mode = settingsRef.current.mode;
        const defaultThreshold = mode === 1 ? nextWindowing.p60 : mode === 2 ? nextWindowing.p35 : nextWindowing.p10;
        updateSettings({ ...settingsRef.current, threshold: defaultThreshold });
    }, [volume]);

    useEffect(() => {
        const gl = glRef.current;
        if (!gl) return;
        if (segTexRef.current) { gl.deleteTexture(segTexRef.current); segTexRef.current = null; }
        if (segmentation) {
            segTexRef.current = create3DTexture(gl, segmentation, true);
            const next = { ...settingsRef.current, mode: 2 as const, threshold: windowing.p35 };
            updateSettings(next); // Auto-switch to surface mode
        } else {
            const next = { ...settingsRef.current, mode: 0 as const, threshold: windowing.p10 };
            updateSettings(next); // Back to volume
        }
    }, [segmentation, updateSettings, windowing.p10, windowing.p35]);

    // Render Loop
    useEffect(() => {
        const gl = glRef.current;
        const container = containerRef.current;
        const prog = programRef.current;
        const vao = vaoRef.current;
        
        if (!gl || !prog || !vao || !container || !volume || !volTexRef.current) return;

        let rAF: number;
        const render = () => {
            if (autoRotateRef.current && !isDraggingRef.current) {
                rotationRef.current.az = (rotationRef.current.az + 0.5) % 360;
            }

            const w = container.clientWidth;
            const h = container.clientHeight;
            
            // Dynamic Resolution
            const pixelRatio = (isInteracting.current || autoRotateRef.current) ? 0.75 : Math.min(window.devicePixelRatio, 1.5);
            const targetW = Math.floor(w * pixelRatio);
            const targetH = Math.floor(h * pixelRatio);

            if (gl.canvas.width !== targetW || gl.canvas.height !== targetH) {
                gl.canvas.width = targetW;
                gl.canvas.height = targetH;
                gl.viewport(0, 0, targetW, targetH);
            }

            gl.clearColor(0.05, 0.05, 0.05, 1.0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.useProgram(prog);

            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_3D, volTexRef.current);
            gl.uniform1i(gl.getUniformLocation(prog, 'u_volume'), 0);

            gl.uniform1i(gl.getUniformLocation(prog, 'u_hasSeg'), !!segTexRef.current ? 1 : 0);
            if (segTexRef.current) {
                gl.activeTexture(gl.TEXTURE1);
                gl.bindTexture(gl.TEXTURE_3D, segTexRef.current);
                gl.uniform1i(gl.getUniformLocation(prog, 'u_segmentation'), 1);
            }

            // Calculate Physical Aspect Ratio Box
            // Header pixDims: [?, dx, dy, dz, ...]
            // Default to 1 if missing
            const pixDims = volume.header?.pixDims || [1,1,1,1];
            // Safe fallback if pixDims are all 0 or header structure differs
            const dx = pixDims[1] || 1;
            const dy = pixDims[2] || 1;
            const dz = pixDims[3] || 1;

            const [dimX, dimY, dimZ] = volume.dimensions;
            const physX = dimX * dx;
            const physY = dimY * dy;
            const physZ = dimZ * dz;
            const maxDim = Math.max(physX, physY, physZ);
            
            const boxSize = [physX / maxDim, physY / maxDim, physZ / maxDim];

            const radAz = rotationRef.current.az * Math.PI / 180;
            const radEl = rotationRef.current.el * Math.PI / 180;
            const r = 2.0;
            const cx = r * Math.sin(radAz) * Math.cos(radEl);
            const cy = r * Math.sin(radEl);
            const cz = r * Math.cos(radAz) * Math.cos(radEl);
            
            const f = normalize([-cx, -cy, -cz]);
            const up = [0,1,0];
            const s = normalize(cross(f, up));
            const u = cross(s, f);
            
            const invViewRot = [s[0], s[1], s[2], 0, u[0], u[1], u[2], 0, -f[0], -f[1], -f[2], 0, 0, 0, 0, 1];

            gl.uniformMatrix4fv(gl.getUniformLocation(prog, 'u_invViewRot'), false, new Float32Array(invViewRot));
            gl.uniform3f(gl.getUniformLocation(prog, 'u_dims'), dimX, dimY, dimZ);
            gl.uniform3f(gl.getUniformLocation(prog, 'u_boxSize'), boxSize[0], boxSize[1], boxSize[2]);
            const wl = wlRef.current;
            if (wl) {
                const { lo, hi } = windowBounds(wl);
                gl.uniform2f(gl.getUniformLocation(prog, 'u_dataRange'), lo, hi);
            } else {
                gl.uniform2f(gl.getUniformLocation(prog, 'u_dataRange'), volume.min, volume.max);
            }
            gl.uniform1f(gl.getUniformLocation(prog, 'u_zoom'), zoomRef.current);
            gl.uniform2f(gl.getUniformLocation(prog, 'u_pan'), panRef.current.x, panRef.current.y);
            gl.uniform1f(gl.getUniformLocation(prog, 'u_opacity'), settingsRef.current.opacity);
            gl.uniform1f(gl.getUniformLocation(prog, 'u_threshold'), settingsRef.current.threshold);
            gl.uniform1i(gl.getUniformLocation(prog, 'u_mode'), settingsRef.current.mode);
            gl.uniform3f(gl.getUniformLocation(prog, 'u_lightDir'), -f[0], -f[1], -f[2]);
            
            const qualityBase = settingsRef.current.mode === 2 ? 0.0025 : 0.003;
            const stepSize = (isInteracting.current || autoRotateRef.current) ? 0.015 : qualityBase;
            gl.uniform1f(gl.getUniformLocation(prog, 'u_stepSize'), stepSize);

            gl.bindVertexArray(vao);
            gl.drawArrays(gl.TRIANGLES, 0, 6);

            rAF = requestAnimationFrame(render);
        };
        render();
        return () => cancelAnimationFrame(rAF);

    }, [volume, segmentation]);

    const normalize = (v: number[]) => { const l = Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]); return [v[0]/l, v[1]/l, v[2]/l]; };
    const cross = (a: number[], b: number[]) => [a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0]];

    const startInteraction = () => {
        isInteracting.current = true;
        setIsInteractingUi(true);
        if (interactionTimeout.current) clearTimeout(interactionTimeout.current);
    };

    const endInteraction = () => {
        if (interactionTimeout.current) clearTimeout(interactionTimeout.current);
        interactionTimeout.current = setTimeout(() => {
            isInteracting.current = false;
            setIsInteractingUi(false);
            syncUiFromRefs();
        }, 300);
    };

    const [dragUi, setDragUi] = useState<'none' | 'rotate' | 'pan' | 'zoom'>('none');

    const applyDragDelta = useCallback((dx: number, dy: number) => {
        const w = Math.max(320, containerRef.current?.clientWidth ?? 800);
        const rotSens = 280 / w;
        const panScale = 0.0028 / Math.max(0.2, zoomRef.current);

        if (dragTypeRef.current === 'rotate') {
            rotationRef.current.az += dx * rotSens;
            rotationRef.current.el = Math.max(-89, Math.min(89, rotationRef.current.el - dy * rotSens * 0.92));
        } else if (dragTypeRef.current === 'pan') {
            panRef.current = {
                x: panRef.current.x - dx * panScale,
                y: panRef.current.y + dy * panScale
            };
        } else if (dragTypeRef.current === 'zoom') {
            zoomRef.current = Math.max(0.12, Math.min(16, zoomRef.current * Math.exp(-dy * 0.009)));
        }
    }, []);

    const detachWindowDrag = useRef<(() => void) | null>(null);

    useEffect(() => {
        return () => {
            detachWindowDrag.current?.();
        };
    }, []);

    const handleMouseDown = (e: React.MouseEvent) => {
        if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;

        const target = e.target as HTMLElement;
        if (target.closest('button, input, select, textarea, label')) return;

        detachWindowDrag.current?.();

        if (e.button === 1) {
            e.preventDefault();
            dragTypeRef.current = 'pan';
            setDragUi('pan');
        } else if (e.button === 2) {
            e.preventDefault();
            dragTypeRef.current = 'zoom';
            setDragUi('zoom');
        } else if (e.button === 0 && e.shiftKey) {
            dragTypeRef.current = 'pan';
            setDragUi('pan');
        } else if (e.button === 0) {
            dragTypeRef.current = 'rotate';
            setDragUi('rotate');
        }

        isDraggingRef.current = true;
        lastMouseRef.current = { x: e.clientX, y: e.clientY };
        startInteraction();

        const onWinMove = (ev: MouseEvent) => {
            if (!isDraggingRef.current) return;
            startInteraction();
            const dx = ev.clientX - lastMouseRef.current.x;
            const dy = ev.clientY - lastMouseRef.current.y;
            lastMouseRef.current = { x: ev.clientX, y: ev.clientY };
            applyDragDelta(dx, dy);
        };

        const onWinUp = () => {
            window.removeEventListener('mousemove', onWinMove);
            window.removeEventListener('mouseup', onWinUp);
            detachWindowDrag.current = null;
            isDraggingRef.current = false;
            setDragUi('none');
            endInteraction();
        };

        window.addEventListener('mousemove', onWinMove);
        window.addEventListener('mouseup', onWinUp);
        detachWindowDrag.current = () => {
            window.removeEventListener('mousemove', onWinMove);
            window.removeEventListener('mouseup', onWinUp);
        };
    };

    const handleWheel = (e: React.WheelEvent) => {
        e.preventDefault();
        startInteraction();
        const dy = e.deltaY;
        const step = (Math.min(Math.abs(dy), 80) / 80) * Math.sign(dy);
        zoomRef.current = Math.max(0.12, Math.min(16, zoomRef.current * Math.exp(-step * 0.2)));
        endInteraction();
    };

    const cursorClass =
        dragUi === 'pan'
            ? 'cursor-move'
            : dragUi === 'zoom'
              ? 'cursor-ns-resize'
              : dragUi === 'rotate'
                ? 'cursor-grabbing'
                : 'cursor-grab';

    const toggleFullscreen = () => {
        if (!containerRef.current) return;
        if (!document.fullscreenElement) { containerRef.current.requestFullscreen(); setIsFullscreen(true); } 
        else { document.exitFullscreen(); setIsFullscreen(false); }
    };

    const resetView = () => {
        rotationRef.current = { az: 45, el: 20 };
        zoomRef.current = 1.0;
        panRef.current = { x: 0, y: 0 };
        syncUiFromRefs();
    };

    const setPresetView = (az: number, el: number) => {
        rotationRef.current = { az, el };
        syncUiFromRefs();
    };

    return (
        <div 
            ref={containerRef} 
            onMouseDown={handleMouseDown} 
            onWheel={handleWheel}
            onDoubleClick={onDoubleClickLayout}
            onContextMenu={(e) => e.preventDefault()}
            className={`relative h-full w-full bg-black border-2 border-gray-800 overflow-hidden group select-none touch-none ${cursorClass}`}
        >
             <div className="absolute top-2 left-2 pointer-events-none flex flex-col gap-1 z-10">
                 <div className="text-xs font-mono text-cyan-400 bg-black/60 px-2 py-1 rounded">
                     3D Render: {settings.mode === 2 ? 'Segmentation Surface' : settings.mode === 1 ? 'MIP' : 'Volumetric'}
                 </div>
                 <div className="text-[10px] text-gray-400 bg-black/40 px-2 py-0.5 rounded backdrop-blur-sm max-w-[220px] leading-snug">
                     Left: orbit · Middle or Shift+left: pan · Right drag: zoom · Wheel: zoom
                 </div>
             </div>
             
             <div className="absolute top-2 right-2 flex flex-col gap-1 z-20 transition-opacity">
                 <button onClick={toggleFullscreen} className="p-1.5 rounded bg-black/60 hover:bg-gray-800 text-gray-400 hover:text-white" title="Toggle Fullscreen">
                    {isFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
                 </button>
                 <button onClick={resetView} className="p-1.5 rounded bg-black/60 hover:bg-gray-800 text-gray-400 hover:text-white" title="Reset View">
                    <RefreshCcw className="w-4 h-4" />
                 </button>
             </div>

             <div className="absolute top-1/2 right-2 -translate-y-1/2 flex flex-col gap-1 z-20 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                <button onClick={() => setPresetView(0, 0)} className="w-6 h-6 rounded bg-black/60 hover:bg-cyan-900 text-[10px] text-gray-300 border border-gray-700 hover:border-cyan-500">A</button>
                <button onClick={() => setPresetView(180, 0)} className="w-6 h-6 rounded bg-black/60 hover:bg-cyan-900 text-[10px] text-gray-300 border border-gray-700 hover:border-cyan-500">P</button>
                <button onClick={() => setPresetView(90, 0)} className="w-6 h-6 rounded bg-black/60 hover:bg-cyan-900 text-[10px] text-gray-300 border border-gray-700 hover:border-cyan-500">L</button>
                <button onClick={() => setPresetView(270, 0)} className="w-6 h-6 rounded bg-black/60 hover:bg-cyan-900 text-[10px] text-gray-300 border border-gray-700 hover:border-cyan-500">R</button>
                <button onClick={() => setPresetView(0, 90)} className="w-6 h-6 rounded bg-black/60 hover:bg-cyan-900 text-[10px] text-gray-300 border border-gray-700 hover:border-cyan-500">S</button>
                <button onClick={() => setPresetView(0, -90)} className="w-6 h-6 rounded bg-black/60 hover:bg-cyan-900 text-[10px] text-gray-300 border border-gray-700 hover:border-cyan-500">I</button>
             </div>
             
             <div className="absolute bottom-2 left-2 z-20">
                 <button onClick={() => setShowSettings(!showSettings)} className="p-1.5 bg-black/60 rounded text-cyan-400 hover:text-white transition-colors">
                     <Settings className="w-4 h-4" />
                 </button>
                 {showSettings && (
                     <div className="absolute bottom-8 left-0 w-48 bg-gray-900/90 border border-gray-700 rounded p-3 text-xs text-gray-200 backdrop-blur-sm shadow-xl">
                        <div className="space-y-3">
                            <div>
                                <label className="block text-gray-400 mb-1">Mode</label>
                                <select
                                    value={settings.mode}
                                    onChange={(e) => {
                                        const mode = Number(e.target.value) as 0 | 1 | 2;
                                        const threshold = mode === 1 ? windowing.p60 : mode === 2 ? windowing.p35 : windowing.p10;
                                        updateSettings({ ...settings, mode, threshold });
                                    }}
                                    className="w-full bg-gray-800 border border-gray-600 rounded p-1"
                                >
                                    <option value={0}>Volumetric (Cloud)</option>
                                    <option value={1}>MIP (Max Intensity)</option>
                                    <option value={2}>Surface (Segmentation)</option>
                                </select>
                            </div>
                            <div>
                                <label className="flex justify-between text-gray-400 mb-1">
                                    Opacity <span className="text-cyan-400">{Math.round(settings.opacity * 100)}%</span>
                                </label>
                                <input type="range" min="0.05" max="1" step="0.05" value={settings.opacity} onChange={(e) => updateSettings({...settings, opacity: Number(e.target.value)})} className="w-full h-1 bg-gray-700 rounded appearance-none accent-cyan-500" />
                            </div>
                            <div>
                                <label className="flex justify-between text-gray-400 mb-1">
                                    Threshold <span className="text-cyan-400">{settings.threshold}</span>
                                </label>
                                <input type="range" min="0" max="255" step="1" value={settings.threshold} onChange={(e) => updateSettings({...settings, threshold: Number(e.target.value)})} className="w-full h-1 bg-gray-700 rounded appearance-none accent-cyan-500" />
                            </div>
                            <div className="pt-2 border-t border-gray-700 flex flex-col gap-1">
                                <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={autoRotate} onChange={(e) => setAutoRotate(e.target.checked)} className="rounded bg-gray-700 border-gray-600 text-cyan-500 focus:ring-0" />
                                    <span>Auto Rotate</span>
                                </label>
                            </div>
                        </div>
                     </div>
                 )}
             </div>

             <div className="absolute bottom-2 right-2 text-[10px] font-mono text-gray-400 bg-black/50 px-2 py-1 rounded z-20">
                AZ {Math.round(rotationUi.az)} / EL {Math.round(rotationUi.el)} | Z {zoomUi.toFixed(2)}
             </div>

             <canvas ref={setCanvasRef} className="block w-full h-full pointer-events-none" />
        </div>
    );
}));

export const Viewport = forwardRef<ViewportHandle, ViewportProps>((props, ref) => {
    const { 
        viewMode, onViewModeChange, volume, segmentation, tool, onToolChange, brushSize, onUpdateSegmentation,
        position, onPositionChange,
        colormap, opacity, overlayVolume, overlayOpacity, overlayColormap,
        windowLevel, onWindowLevelChange, enableSliceKeys = true,
        brushLabel = 1, onPaintStrokeStart, onPaintHistoryChange,
        displayConvention = 'radiological', onDisplayConventionChange,
        cinePlaying = false, onCinePlayingChange
    } = props;

    const toggleLayout = (target: ViewMode) => {
        if (!onViewModeChange) return;
        onViewModeChange(viewMode === target ? ViewMode.FourUp : target);
    };
    
    const [localPos, setLocalPos] = useState({ x: 0, y: 0, z: 0 });
    const [measurements, setMeasurements] = useState<SliceMeasurement[]>([]);
    const [focusPlane, setFocusPlane] = useState<SliceOrientation>('Axial');
    const measureIdRef = useRef(1);
    const pos = position || localPos;
    const gridKey = `${volume?.dimensions.join('x')}|${(volume?.affine ?? []).slice(0, 12).join(',')}`;

    useEffect(() => {
        setMeasurements([]);
        measureIdRef.current = 1;
    }, [gridKey]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            if (target) {
                const tag = target.tagName;
                if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
            }
            if (e.key === ' ' || e.code === 'Space') {
                if (e.repeat) return;
                e.preventDefault();
                onCinePlayingChange?.(!cinePlaying);
                return;
            }
            if (e.key === 'Backspace' || e.key === 'Delete') {
                if (tool !== 'measure') return;
                e.preventDefault();
                setMeasurements((prev) => prev.slice(0, -1));
                return;
            }
            if (!enableSliceKeys || !volume) return;
            const [dimX, dimY, dimZ] = volume.dimensions;
            const plane: SliceOrientation =
                viewMode === ViewMode.Axial ? 'Axial'
                : viewMode === ViewMode.Coronal ? 'Coronal'
                : viewMode === ViewMode.Sagittal ? 'Sagittal'
                : focusPlane;
            const axis = plane === 'Axial' ? 'z' : plane === 'Coronal' ? 'y' : 'x';
            const max = axis === 'z' ? dimZ : axis === 'y' ? dimY : dimX;
            const step = e.shiftKey ? 10 : 1;
            let delta = 0;
            if (e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === ',' || e.key === '<') delta = -step;
            else if (e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === '.' || e.key === '>') delta = step;
            else if (e.key === 'Home') {
                e.preventDefault();
                handlePosChange({ ...pos, [axis]: 0 });
                return;
            } else if (e.key === 'End') {
                e.preventDefault();
                handlePosChange({ ...pos, [axis]: max - 1 });
                return;
            }
            if (!delta) return;
            e.preventDefault();
            const cur = axis === 'z' ? pos.z : axis === 'y' ? pos.y : pos.x;
            const next = Math.max(0, Math.min(max - 1, cur + delta));
            handlePosChange({ ...pos, [axis]: next });
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [tool, volume, viewMode, focusPlane, pos, enableSliceKeys, cinePlaying, onCinePlayingChange]);

    const commitMeasurement = (
        orientation: SliceOrientation,
        slice: number,
        start: { u: number; v: number },
        end: { u: number; v: number }
    ) => {
        setMeasurements((prev) => [
            ...prev,
            { id: measureIdRef.current++, orientation, slice: displayedSliceIndex(slice), start, end }
        ]);
    };
    
    const handlePosChange = (p: {x:number, y:number, z:number}) => {
        if (onPositionChange) onPositionChange(p);
        else setLocalPos(p);
    };

    const canvas3DRef = useRef<HTMLCanvasElement>(null);

    const paintHistoryRef = useRef<Uint8Array[]>([]);

    const snapshotPaint = useCallback(() => {
        if (!segmentation?.data) {
            paintHistoryRef.current.push(new Uint8Array(volume?.data.length ?? 0));
        } else {
            const copy = new Uint8Array(segmentation.data.length);
            copy.set(segmentation.data as ArrayLike<number>);
            paintHistoryRef.current.push(copy);
        }
        if (paintHistoryRef.current.length > 15) paintHistoryRef.current.shift();
        onPaintHistoryChange?.(paintHistoryRef.current.length);
        onPaintStrokeStart?.();
    }, [segmentation, volume, onPaintStrokeStart, onPaintHistoryChange]);

    const undoPaint = useCallback(() => {
        const prev = paintHistoryRef.current.pop();
        onPaintHistoryChange?.(paintHistoryRef.current.length);
        if (!prev || !onUpdateSegmentation) return false;
        let mx = 0;
        for (let i = 0; i < prev.length; i++) if (prev[i] > mx) mx = prev[i];
        const base = segmentation ?? volume;
        if (!base) return false;
        onUpdateSegmentation({
            ...base,
            header: { ...base.header, datatypeCode: 2 },
            data: prev,
            min: 0,
            max: Math.max(1, mx)
        });
        return true;
    }, [segmentation, volume, onUpdateSegmentation, onPaintHistoryChange]);

    const handleDraw = useCallback((x: number, y: number, z: number, val: number, radius: number) => {
        if (!volume || !onUpdateSegmentation) return;
        
        let segVol = segmentation;
        if (!segVol) {
            const len = volume.data.length;
            segVol = {
                ...volume,
                header: { ...volume.header, datatypeCode: 2 },
                data: new Uint8Array(len),
                min: 0, 
                max: 1
            };
        }
        
        const [dimX, dimY, dimZ] = volume.dimensions;
        const r2 = radius * radius;
        for(let dz = -radius; dz <= radius; dz++) {
            for(let dy = -radius; dy <= radius; dy++) {
                for(let dx = -radius; dx <= radius; dx++) {
                     if (dx*dx + dy*dy + dz*dz <= r2) {
                         const px = x + dx; 
                         const py = y + dy; 
                         const pz = z + dz;
                         if (px>=0 && px<dimX && py>=0 && py<dimY && pz>=0 && pz<dimZ) {
                             const idx = pz*dimX*dimY + py*dimX + px;
                             segVol.data[idx] = val;
                             if (val > segVol.max) segVol.max = val;
                         }
                     }
                }
            }
        }
        
        onUpdateSegmentation({ ...segVol });
        
    }, [volume, segmentation, onUpdateSegmentation]);

    const capturePlane = (orientation: SliceOrientation, sliceIndices: number[]): string[] => {
        if (!volume) return [];
        const urls: string[] = [];
        for (const idx of sliceIndices) {
            const bmp = generateSliceBitmap(
                volume,
                segmentation ?? null,
                orientation,
                idx,
                colormap || 'grayscale',
                opacity ?? 1,
                windowLevel,
                sliceFlipH(orientation, volume, displayConvention)
            );
            if (!bmp) continue;
            const url = canvasToJpegDataUrl(bmp);
            if (url) urls.push(url);
        }
        return urls;
    };

    useEffect(() => {
        paintHistoryRef.current = [];
        onPaintHistoryChange?.(0);
    }, [gridKey, onPaintHistoryChange]);

    const posRef = useRef(pos);
    posRef.current = pos;
    useEffect(() => {
        if (!cinePlaying || !volume || viewMode === ViewMode.ThreeD) return;
        const [dimX, dimY, dimZ] = volume.dimensions;
        const id = window.setInterval(() => {
            const p = posRef.current;
            const plane: SliceOrientation =
                viewMode === ViewMode.Axial ? 'Axial'
                : viewMode === ViewMode.Coronal ? 'Coronal'
                : viewMode === ViewMode.Sagittal ? 'Sagittal'
                : focusPlane;
            if (plane === 'Axial') handlePosChange({ ...p, z: (p.z + 1) % dimZ });
            else if (plane === 'Coronal') handlePosChange({ ...p, y: (p.y + 1) % dimY });
            else handlePosChange({ ...p, x: (p.x + 1) % dimX });
        }, 80);
        return () => window.clearInterval(id);
    }, [cinePlaying, volume, viewMode, focusPlane]);

    useImperativeHandle(ref, () => ({
        undoPaint,
        getReportImages: async (): Promise<ReportImages> => {
            if (!volume) return { axial: [], coronal: [], sagittal: [], threeD: [] };
            const [dimX, dimY, dimZ] = volume.dimensions;
            const three = captureWebglJpeg(canvas3DRef.current);
            return {
                axial: capturePlane('Axial', pickSnapshotIndices(dimZ, pos.z)),
                coronal: capturePlane('Coronal', pickSnapshotIndices(dimY, pos.y)),
                sagittal: capturePlane('Sagittal', pickSnapshotIndices(dimX, pos.x)),
                threeD: three ? [three] : []
            };
        }
    }), [volume, segmentation, pos, colormap, opacity, windowLevel, undoPaint, displayConvention]);

    if (!volume) return <div className="flex items-center justify-center h-full text-gray-600">No Volume Loaded</div>;

    const [dimX, dimY, dimZ] = volume.dimensions;

    const renderAxial = () => (
        <SliceViewer 
            title="Axial" orientation="Axial" color="#ef4444" isActive={true}
            volume={volume} segmentation={segmentation}
            slice={pos.z} maxSlice={dimZ}
            onSliceChange={(s) => handlePosChange({...pos, z: s})}
            onCrosshairChange={(u,v) => handlePosChange({...pos, x: u, y: v})}
            crosshair={{x: pos.x, y: pos.y}}
            tool={tool || 'crosshair'} brushSize={brushSize || 5} brushLabel={brushLabel}
            onDraw={handleDraw} onPaintStrokeStart={snapshotPaint}
            flipH={sliceFlipH('Axial', volume, displayConvention)}
            colormap={colormap} opacity={opacity}
            overlayVolume={overlayVolume} overlayOpacity={overlayOpacity} overlayColormap={overlayColormap}
            onDoubleClickLayout={() => toggleLayout(ViewMode.Axial)}
            measurements={measurements}
            onCommitMeasurement={(start, end) => commitMeasurement('Axial', pos.z, start, end)}
            windowLevel={windowLevel}
            onWindowLevelChange={onWindowLevelChange}
            onActivate={() => setFocusPlane('Axial')}
        />
    );

    const renderCoronal = () => (
        <SliceViewer 
            title="Coronal" orientation="Coronal" color="#22c55e" isActive={true}
            volume={volume} segmentation={segmentation}
            slice={pos.y} maxSlice={dimY}
            onSliceChange={(s) => handlePosChange({...pos, y: s})}
            onCrosshairChange={(u,v) => handlePosChange({...pos, x: u, z: v})}
            crosshair={{x: pos.x, y: pos.z}}
            tool={tool || 'crosshair'} brushSize={brushSize || 5} brushLabel={brushLabel}
            onDraw={handleDraw} onPaintStrokeStart={snapshotPaint}
            flipH={sliceFlipH('Coronal', volume, displayConvention)}
            colormap={colormap} opacity={opacity}
            overlayVolume={overlayVolume} overlayOpacity={overlayOpacity} overlayColormap={overlayColormap}
            onDoubleClickLayout={() => toggleLayout(ViewMode.Coronal)}
            measurements={measurements}
            onCommitMeasurement={(start, end) => commitMeasurement('Coronal', pos.y, start, end)}
            windowLevel={windowLevel}
            onWindowLevelChange={onWindowLevelChange}
            onActivate={() => setFocusPlane('Coronal')}
        />
    );

    const renderSagittal = () => (
         <SliceViewer 
            title="Sagittal" orientation="Sagittal" color="#3b82f6" isActive={true}
            volume={volume} segmentation={segmentation}
            slice={pos.x} maxSlice={dimX}
            onSliceChange={(s) => handlePosChange({...pos, x: s})}
            onCrosshairChange={(u,v) => handlePosChange({...pos, y: u, z: v})} 
            crosshair={{x: pos.y, y: pos.z}}
            tool={tool || 'crosshair'} brushSize={brushSize || 5} brushLabel={brushLabel}
            onDraw={handleDraw} onPaintStrokeStart={snapshotPaint}
            flipH={sliceFlipH('Sagittal', volume, displayConvention)}
            colormap={colormap} opacity={opacity}
            overlayVolume={overlayVolume} overlayOpacity={overlayOpacity} overlayColormap={overlayColormap}
            onDoubleClickLayout={() => toggleLayout(ViewMode.Sagittal)}
            measurements={measurements}
            onCommitMeasurement={(start, end) => commitMeasurement('Sagittal', pos.x, start, end)}
            windowLevel={windowLevel}
            onWindowLevelChange={onWindowLevelChange}
            onActivate={() => setFocusPlane('Sagittal')}
        />
    );
    
    const render3D = () => (
        <Volume3DViewer 
            ref={canvas3DRef}
            volume={volume} 
            segmentation={segmentation} 
            crosshair={pos}
            onDoubleClickLayout={() => toggleLayout(ViewMode.ThreeD)}
            windowLevel={windowLevel}
        />
    );

    const toolBtn = (id: ViewportTool, label: string, Icon: typeof Sun) => {
        const active = (tool || 'crosshair') === id;
        return (
            <button
                type="button"
                onClick={() => onToolChange?.(id)}
                title={
                    id === 'crosshair' ? 'Crosshair (C) — click or drag to navigate slices'
                    : id === 'measure' ? 'Measure (M/R) — drag on a 2D slice, Shift to axis-lock'
                    : id === 'wl' ? 'W/L (W) — drag to window/level'
                    : id === 'pan' ? 'Pan (P) — drag slice. Middle-drag also pans. Double-click fit'
                    : id === 'zoom' ? 'Zoom (Z) — drag up/down or Ctrl+wheel'
                    : label
                }
                className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium uppercase tracking-wide transition-colors ${
                    active ? 'bg-cyan-900/70 text-cyan-300' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-700/80'
                }`}
            >
                <Icon className="w-3.5 h-3.5" />
                {label}
            </button>
        );
    };

    const wrap = (inner: React.ReactNode) => (
        <div className="relative w-full h-full min-h-0">
            {onToolChange && (
                <div className="absolute top-2 left-1/2 -translate-x-1/2 z-30 flex items-center gap-0.5 rounded-lg border border-gray-700 bg-gray-900/90 p-0.5 shadow-lg">
                    {toolBtn('crosshair', 'Crosshair', MousePointer2)}
                    {toolBtn('pan', 'Pan', Move)}
                    {toolBtn('zoom', 'Zoom', ZoomIn)}
                    {toolBtn('wl', 'W/L', Sun)}
                    {toolBtn('measure', 'Measure', Ruler)}
                    <button
                        type="button"
                        onClick={() => onCinePlayingChange?.(!cinePlaying)}
                        title={cinePlaying ? 'Pause cine (Space)' : 'Play cine through slices (Space)'}
                        className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium uppercase tracking-wide transition-colors ${
                            cinePlaying ? 'bg-cyan-900/70 text-cyan-300' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-700/80'
                        }`}
                    >
                        {cinePlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                        {cinePlaying ? 'Pause' : 'Cine'}
                    </button>
                    <button
                        type="button"
                        onClick={() => onDisplayConventionChange?.(displayConvention === 'radiological' ? 'neurological' : 'radiological')}
                        title="Radiological: R on left. Neurological: L on left. Axial and coronal only."
                        className="flex items-center px-2 py-1 rounded-md text-[11px] font-medium uppercase tracking-wide text-amber-300/90 hover:bg-gray-700/80"
                    >
                        {displayConvention === 'radiological' ? 'Rad' : 'Neuro'}
                    </button>
                    {windowLevel && onWindowLevelChange && volume && (
                        <>
                            <div className="mx-0.5 h-4 w-px bg-gray-700" />
                            <select
                                aria-label="Window/level preset"
                                key={gridKey}
                                defaultValue="auto"
                                onChange={(e) => {
                                    const preset = WL_PRESETS.find((p) => p.id === e.target.value);
                                    if (preset) onWindowLevelChange(applyWlPreset(volume, preset));
                                }}
                                className="bg-transparent text-[10px] uppercase tracking-wide text-gray-300 px-1 py-1 outline-none cursor-pointer"
                            >
                                {WL_PRESETS.map((preset: WlPreset) => (
                                    <option key={preset.id} value={preset.id} className="bg-gray-900">
                                        {preset.label}
                                    </option>
                                ))}
                            </select>
                            <span className="px-1.5 font-mono text-[10px] text-gray-500 whitespace-nowrap">
                                {formatWindowLevel(windowLevel)}
                            </span>
                        </>
                    )}
                    {measurements.length > 0 && (
                        <button
                            type="button"
                            onClick={() => setMeasurements([])}
                            title="Clear all measurements"
                            className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium uppercase tracking-wide text-gray-400 hover:text-red-300 hover:bg-gray-700/80"
                        >
                            <Trash2 className="w-3.5 h-3.5" />
                            Clear
                        </button>
                    )}
                </div>
            )}
            {inner}
            {volume && measurements.length > 0 && (
                <div className="absolute bottom-2 left-2 z-20 min-w-[160px] max-w-[240px] rounded-md border border-gray-700 bg-black/80 p-1.5 shadow-lg">
                    <div className="mb-1 text-[9px] uppercase tracking-wide text-gray-500">Measurements</div>
                    <div className="space-y-0.5">
                        {measurements.slice(-8).map((m) => {
                            const mm = measurementLengthMm(
                                volume, m.orientation, m.slice, m.start, m.end,
                                sliceFlipH(m.orientation, volume, displayConvention)
                            );
                            const short = m.orientation.slice(0, 3);
                            return (
                                <button
                                    key={m.id}
                                    type="button"
                                    title={`Go to ${m.orientation} slice ${m.slice + 1}`}
                                    onClick={() => {
                                        if (m.orientation === 'Axial') handlePosChange({ ...pos, z: m.slice });
                                        else if (m.orientation === 'Coronal') handlePosChange({ ...pos, y: m.slice });
                                        else handlePosChange({ ...pos, x: m.slice });
                                    }}
                                    className="flex w-full items-center justify-between gap-3 rounded px-1 py-0.5 text-left font-mono text-[10px] text-cyan-200 hover:bg-gray-800"
                                >
                                    <span className="text-gray-400">{short} {m.slice + 1}</span>
                                    <span>{formatLengthMm(mm)}</span>
                                </button>
                            );
                        })}
                    </div>
                    {measurements.length > 8 && (
                        <div className="mt-1 text-[9px] text-gray-500">{measurements.length - 8} earlier hidden</div>
                    )}
                </div>
            )}
            {(tool || 'crosshair') === 'measure' && viewMode === ViewMode.ThreeD && (
                <div className="absolute bottom-8 left-1/2 -translate-x-1/2 z-20 text-[11px] text-cyan-300 bg-black/70 px-2 py-1 rounded pointer-events-none">
                    Switch to Axial, Coronal, or Sagittal to measure
                </div>
            )}
        </div>
    );

    if (viewMode === ViewMode.Axial) return wrap(<div className="w-full h-full">{renderAxial()}</div>);
    if (viewMode === ViewMode.Coronal) return wrap(<div className="w-full h-full">{renderCoronal()}</div>);
    if (viewMode === ViewMode.Sagittal) return wrap(<div className="w-full h-full">{renderSagittal()}</div>);
    if (viewMode === ViewMode.ThreeD) return wrap(<div className="w-full h-full">{render3D()}</div>);

    return wrap(
        <div className="grid grid-cols-2 grid-rows-2 h-full w-full bg-black gap-0.5">
            {renderAxial()}
            {renderCoronal()}
            {renderSagittal()}
            {render3D()}
        </div>
    );
});
import React, { useState, useEffect, useRef, useMemo, useCallback, useImperativeHandle, forwardRef } from 'react';
import { ViewMode, VolumeData, ViewportHandle, ReportImages, ViewportTool } from '../types';
import { Move, ZoomIn, Sun, Ruler, Rotate3d, Layers, Play, Pause, Maximize, Settings, Sliders, ChevronDown, ChevronUp, Ghost, PenTool, Eraser, Minimize, MousePointer2, RefreshCcw, Box } from 'lucide-react';

interface ViewportProps {
    viewMode: ViewMode;
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
    onDraw?: (x: number, y: number, z: number, val: number, radius: number) => void;
    colormap?: 'grayscale' | 'hot-cold';
    opacity?: number;
    overlayVolume?: VolumeData | null;
    overlayOpacity?: number;
    overlayColormap?: 'grayscale' | 'hot-cold';
}

interface Volume3DViewerProps {
    volume: VolumeData | null;
    segmentation?: VolumeData | null;
    crosshair: { x: number, y: number, z: number };
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
    opacity: number = 1.0
): HTMLCanvasElement | null => {
    if (!volume) return null;
    
    const { data, dimensions, min, max } = volume;
    const [dimX, dimY, dimZ] = dimensions;
    const sliceIdx = Math.floor(slice);

    let width = 0, height = 0;
    let xStride = 0, yStride = 0, origin = 0;

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
    } else {
        const range = (max - min) || 1;
        scale = 255 * 1.2 / range;
        offset = min;
    }
    
    const segData = segmentation ? segmentation.data : null;
    const useDiffPalette = segmentation && segmentation.max <= 3 && segmentation.max > 0;
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
        float val = (rawVal - u_dataRange.x) / (u_dataRange.y - u_dataRange.x);
        
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

const SliceViewer: React.FC<SliceViewerProps> = ({ 
    title, orientation, color, isActive, 
    volume, segmentation, 
    slice, maxSlice, onSliceChange, 
    onCrosshairChange, crosshair, 
    tool, brushSize, onDraw, 
    colormap, opacity, overlayVolume, overlayOpacity, overlayColormap 
}) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [isDragging, setIsDragging] = useState(false);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !volume) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        
        const baseBitmap = generateSliceBitmap(volume, segmentation, orientation, slice, colormap, opacity);
        let overlayBitmap = null;
        if (overlayVolume) {
             overlayBitmap = generateSliceBitmap(overlayVolume, null, orientation, slice, overlayColormap || 'hot-cold', overlayOpacity);
        }

        if (baseBitmap) {
            canvas.width = baseBitmap.width;
            canvas.height = baseBitmap.height;
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(baseBitmap, 0, 0);

            if (overlayBitmap) {
                 ctx.globalAlpha = overlayOpacity || 0.5;
                 ctx.drawImage(overlayBitmap, 0, 0);
                 ctx.globalAlpha = 1.0;
            }

            if (isActive) {
                ctx.strokeStyle = color;
                ctx.lineWidth = 0.5;
                ctx.beginPath();
                ctx.moveTo(crosshair.x + 0.5, 0);
                ctx.lineTo(crosshair.x + 0.5, canvas.height);
                ctx.moveTo(0, crosshair.y + 0.5);
                ctx.lineTo(canvas.width, crosshair.y + 0.5);
                ctx.stroke();
            }
        }
    }, [volume, segmentation, orientation, slice, colormap, opacity, overlayVolume, overlayOpacity, crosshair, isActive, color]);

    const handleMouseDown = (e: React.MouseEvent) => { setIsDragging(true); handleMouseMove(e); };
    const handleMouseUp = () => setIsDragging(false);
    
    const handleMouseMove = (e: React.MouseEvent) => {
        if (!isDragging && e.buttons !== 1) return;
        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect || !volume) return;

        const x = (e.clientX - rect.left) / rect.width;
        const y = (e.clientY - rect.top) / rect.height;
        
        let imgW = 0, imgH = 0;
        if (orientation === 'Axial') { imgW = volume.dimensions[0]; imgH = volume.dimensions[1]; }
        if (orientation === 'Coronal') { imgW = volume.dimensions[0]; imgH = volume.dimensions[2]; }
        if (orientation === 'Sagittal') { imgW = volume.dimensions[1]; imgH = volume.dimensions[2]; }

        const u = Math.max(0, Math.min(imgW - 1, Math.floor(x * imgW)));
        const v = Math.max(0, Math.min(imgH - 1, Math.floor(y * imgH)));

        if (tool === 'brush' || tool === 'eraser') {
            if (onDraw) {
                let vx=0, vy=0, vz=0;
                if (orientation === 'Axial') { vx=u; vy=v; vz=slice; }
                if (orientation === 'Coronal') { vx=u; vy=slice; vz=v; }
                if (orientation === 'Sagittal') { vx=slice; vy=u; vz=v; } 
                onDraw(vx, vy, vz, tool === 'brush' ? 1 : 0, brushSize);
            }
        } else {
            onCrosshairChange(u, v);
        }
    };

    const handleWheel = (e: React.WheelEvent) => {
        if (e.deltaY !== 0) {
            const delta = e.deltaY > 0 ? 1 : -1;
            const newSlice = Math.max(0, Math.min(maxSlice - 1, slice + delta));
            onSliceChange(newSlice);
        }
    };

    return (
        <div ref={containerRef} className={`relative w-full h-full bg-black border-2 ${isActive ? `border-[${color}]` : 'border-gray-800'} overflow-hidden flex flex-col`}>
             <div className="absolute top-2 left-2 text-xs font-bold" style={{ color }}>
                {title} <span className="text-gray-500 font-mono">[{slice + 1}/{maxSlice}]</span>
            </div>
            <canvas 
                ref={canvasRef}
                className="w-full h-full object-contain touch-none cursor-crosshair"
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
                onWheel={handleWheel}
            />
        </div>
    );
};

const Volume3DViewer = React.memo(forwardRef<HTMLCanvasElement, Volume3DViewerProps>(({ volume, segmentation, crosshair }, ref) => {
    const internalCanvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    
    // View State
    const [rotation, setRotation] = useState({ az: 45, el: 20 });
    const [zoom, setZoom] = useState(1.0);
    const [pan, setPan] = useState({ x: 0, y: 0 });
    const [autoRotate, setAutoRotate] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    
    // Interaction State
    const isInteracting = useRef(false);
    const interactionTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Render Mode Settings
    const [settings, setSettings] = useState({
        mode: 0 as 0 | 1 | 2, 
        threshold: 40,
        opacity: 0.8
    });

    const isDraggingRef = useRef(false);
    const dragTypeRef = useRef<'rotate' | 'pan'>('rotate');
    const lastMouseRef = useRef({ x: 0, y: 0 });

    const glRef = useRef<WebGL2RenderingContext | null>(null);
    const programRef = useRef<WebGLProgram | null>(null);
    const volTexRef = useRef<WebGLTexture | null>(null);
    const segTexRef = useRef<WebGLTexture | null>(null);
    const vaoRef = useRef<WebGLVertexArrayObject | null>(null);

    // Initialize WebGL
    useEffect(() => {
        const canvas = (ref as React.RefObject<HTMLCanvasElement>)?.current || internalCanvasRef.current;
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

    // Load Textures
    useEffect(() => {
        const gl = glRef.current;
        if (!gl || !volume) return;
        if (volTexRef.current) gl.deleteTexture(volTexRef.current);
        volTexRef.current = create3DTexture(gl, volume, false);
    }, [volume]);

    useEffect(() => {
        const gl = glRef.current;
        if (!gl) return;
        if (segTexRef.current) { gl.deleteTexture(segTexRef.current); segTexRef.current = null; }
        if (segmentation) {
            segTexRef.current = create3DTexture(gl, segmentation, true);
            setSettings(s => ({ ...s, mode: 2 })); // Auto-switch to surface mode
        } else {
            setSettings(s => ({ ...s, mode: 0 })); // Back to volume
        }
    }, [segmentation]);

    // Render Loop
    useEffect(() => {
        const gl = glRef.current;
        const container = containerRef.current;
        const prog = programRef.current;
        const vao = vaoRef.current;
        
        if (!gl || !prog || !vao || !container || !volume || !volTexRef.current) return;

        let rAF: number;
        const render = () => {
            if (autoRotate && !isDraggingRef.current) {
                setRotation(r => ({ ...r, az: (r.az + 0.5) % 360 }));
            }

            const w = container.clientWidth;
            const h = container.clientHeight;
            
            // Dynamic Resolution
            const pixelRatio = (isInteracting.current || autoRotate) ? 0.75 : window.devicePixelRatio;
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

            const radAz = rotation.az * Math.PI / 180;
            const radEl = rotation.el * Math.PI / 180;
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
            gl.uniform2f(gl.getUniformLocation(prog, 'u_dataRange'), volume.min, volume.max);
            gl.uniform1f(gl.getUniformLocation(prog, 'u_zoom'), zoom);
            gl.uniform2f(gl.getUniformLocation(prog, 'u_pan'), pan.x, pan.y);
            gl.uniform1f(gl.getUniformLocation(prog, 'u_opacity'), settings.opacity);
            gl.uniform1f(gl.getUniformLocation(prog, 'u_threshold'), settings.threshold);
            gl.uniform1i(gl.getUniformLocation(prog, 'u_mode'), settings.mode);
            gl.uniform3f(gl.getUniformLocation(prog, 'u_lightDir'), -f[0], -f[1], -f[2]);
            
            const stepSize = (isInteracting.current || autoRotate) ? 0.015 : 0.003;
            gl.uniform1f(gl.getUniformLocation(prog, 'u_stepSize'), stepSize);

            gl.bindVertexArray(vao);
            gl.drawArrays(gl.TRIANGLES, 0, 6);

            rAF = requestAnimationFrame(render);
        };
        render();
        return () => cancelAnimationFrame(rAF);

    }, [volume, segmentation, rotation, zoom, pan, settings, autoRotate]);

    const normalize = (v: number[]) => { const l = Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]); return [v[0]/l, v[1]/l, v[2]/l]; };
    const cross = (a: number[], b: number[]) => [a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0]];

    const startInteraction = () => {
        isInteracting.current = true;
        if (interactionTimeout.current) clearTimeout(interactionTimeout.current);
    };

    const endInteraction = () => {
        if (interactionTimeout.current) clearTimeout(interactionTimeout.current);
        interactionTimeout.current = setTimeout(() => {
            isInteracting.current = false;
        }, 300);
    };

    const handleMouseDown = (e: React.MouseEvent) => { 
        isDraggingRef.current = true; 
        lastMouseRef.current = { x: e.clientX, y: e.clientY };
        
        if (e.button === 2 || e.shiftKey) {
            dragTypeRef.current = 'pan';
        } else {
            dragTypeRef.current = 'rotate';
        }
        startInteraction();
    };

    const handleMouseMove = (e: React.MouseEvent) => {
        if (!isDraggingRef.current) return;
        startInteraction();
        
        const dx = e.clientX - lastMouseRef.current.x;
        const dy = e.clientY - lastMouseRef.current.y;
        lastMouseRef.current = { x: e.clientX, y: e.clientY };

        if (dragTypeRef.current === 'rotate') {
            setRotation(r => ({ 
                az: r.az + dx * 0.5, 
                el: Math.max(-89, Math.min(89, r.el - dy * 0.5)) 
            }));
        } else {
            const scale = 0.002 / zoom;
            setPan(p => ({
                x: p.x - dx * scale,
                y: p.y + dy * scale
            }));
        }
    };

    const handleMouseUp = () => { 
        isDraggingRef.current = false; 
        endInteraction(); 
    };

    const handleWheel = (e: React.WheelEvent) => { 
        startInteraction();
        setZoom(prev => Math.max(0.1, Math.min(8.0, prev - Math.sign(e.deltaY) * 0.15)));
        endInteraction();
    };

    const toggleFullscreen = () => {
        if (!containerRef.current) return;
        if (!document.fullscreenElement) { containerRef.current.requestFullscreen(); setIsFullscreen(true); } 
        else { document.exitFullscreen(); setIsFullscreen(false); }
    };

    const resetView = () => {
        setRotation({ az: 45, el: 20 });
        setZoom(1.0);
        setPan({ x: 0, y: 0 });
    };

    const setPresetView = (az: number, el: number) => {
        setRotation({ az, el });
    };

    return (
        <div 
            ref={containerRef} 
            onMouseDown={handleMouseDown} 
            onMouseMove={handleMouseMove} 
            onMouseUp={handleMouseUp} 
            onMouseLeave={handleMouseUp} 
            onWheel={handleWheel} 
            onContextMenu={(e) => e.preventDefault()}
            className={`relative h-full w-full bg-black border-2 border-gray-800 overflow-hidden group ${isInteracting.current ? 'cursor-grabbing' : 'cursor-grab'}`}
        >
             <div className="absolute top-2 left-2 pointer-events-none flex flex-col gap-1 z-10">
                 <div className="text-xs font-mono text-cyan-400 bg-black/60 px-2 py-1 rounded">
                     3D Render: {settings.mode === 2 ? 'Segmentation Surface' : 'Volumetric'}
                 </div>
                 <div className="text-[10px] text-gray-400 bg-black/40 px-2 py-0.5 rounded backdrop-blur-sm">
                     L-Click: Rotate | R-Click: Pan
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
                                <select value={settings.mode} onChange={(e) => setSettings({...settings, mode: Number(e.target.value) as any})} className="w-full bg-gray-800 border border-gray-600 rounded p-1">
                                    <option value={0}>Volumetric (Cloud)</option>
                                    <option value={1}>MIP (Max Intensity)</option>
                                    <option value={2}>Surface (Segmentation)</option>
                                </select>
                            </div>
                            <div>
                                <label className="flex justify-between text-gray-400 mb-1">
                                    Opacity <span className="text-cyan-400">{Math.round(settings.opacity * 100)}%</span>
                                </label>
                                <input type="range" min="0.05" max="1" step="0.05" value={settings.opacity} onChange={(e) => setSettings({...settings, opacity: Number(e.target.value)})} className="w-full h-1 bg-gray-700 rounded appearance-none accent-cyan-500" />
                            </div>
                            <div>
                                <label className="flex justify-between text-gray-400 mb-1">
                                    Threshold <span className="text-cyan-400">{settings.threshold}</span>
                                </label>
                                <input type="range" min="0" max="255" step="1" value={settings.threshold} onChange={(e) => setSettings({...settings, threshold: Number(e.target.value)})} className="w-full h-1 bg-gray-700 rounded appearance-none accent-cyan-500" />
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

             <canvas ref={(ref as React.RefObject<HTMLCanvasElement>) || internalCanvasRef} className="block w-full h-full" />
        </div>
    );
}));

export const Viewport = forwardRef<ViewportHandle, ViewportProps>((props, ref) => {
    const { 
        viewMode, volume, segmentation, tool, onToolChange, brushSize, onUpdateSegmentation,
        position, onPositionChange,
        colormap, opacity, overlayVolume, overlayOpacity, overlayColormap
    } = props;
    
    const [localPos, setLocalPos] = useState({ x: 0, y: 0, z: 0 });
    const pos = position || localPos;
    
    const handlePosChange = (p: {x:number, y:number, z:number}) => {
        if (onPositionChange) onPositionChange(p);
        else setLocalPos(p);
    };

    const canvas3DRef = useRef<HTMLCanvasElement>(null);

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
                         }
                     }
                }
            }
        }
        
        onUpdateSegmentation({ ...segVol });
        
    }, [volume, segmentation, onUpdateSegmentation]);

    useImperativeHandle(ref, () => ({
        getReportImages: async () => {
             if (!volume) return { axial: [], coronal: [], sagittal: [], threeD: [] };
             
             // Capture logic simplified for brevity - assumes canvas refs would be exposed or managed differently in production
             // Here we just return empty or logic to capture from DOM if needed. 
             // Since we need to return images for report, let's grab the 3D one if available.
             let threeD = "";
             if (canvas3DRef.current) {
                 threeD = canvas3DRef.current.toDataURL('image/jpeg', 0.8);
             }
             
             return { axial: [], coronal: [], sagittal: [], threeD: [threeD] };
        }
    }));

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
            tool={tool || 'wl'} brushSize={brushSize || 5}
            onDraw={handleDraw}
            colormap={colormap} opacity={opacity}
            overlayVolume={overlayVolume} overlayOpacity={overlayOpacity} overlayColormap={overlayColormap}
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
            tool={tool || 'wl'} brushSize={brushSize || 5}
            onDraw={handleDraw}
            colormap={colormap} opacity={opacity}
            overlayVolume={overlayVolume} overlayOpacity={overlayOpacity} overlayColormap={overlayColormap}
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
            tool={tool || 'wl'} brushSize={brushSize || 5}
            onDraw={handleDraw}
            colormap={colormap} opacity={opacity}
            overlayVolume={overlayVolume} overlayOpacity={overlayOpacity} overlayColormap={overlayColormap}
        />
    );
    
    const render3D = () => (
        <Volume3DViewer 
            ref={canvas3DRef}
            volume={volume} 
            segmentation={segmentation} 
            crosshair={pos} 
        />
    );

    if (viewMode === ViewMode.Axial) return <div className="w-full h-full">{renderAxial()}</div>;
    if (viewMode === ViewMode.Coronal) return <div className="w-full h-full">{renderCoronal()}</div>;
    if (viewMode === ViewMode.Sagittal) return <div className="w-full h-full">{renderSagittal()}</div>;
    if (viewMode === ViewMode.ThreeD) return <div className="w-full h-full">{render3D()}</div>;

    return (
        <div className="grid grid-cols-2 grid-rows-2 h-full w-full bg-black gap-0.5">
            {renderAxial()}
            {renderCoronal()}
            {renderSagittal()}
            {render3D()}
        </div>
    );
});
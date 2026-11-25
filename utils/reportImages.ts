export function pickSnapshotIndices(count: number, current: number): number[] {
    if (count <= 0) return [0];
    const last = count - 1;
    const cur = Math.max(0, Math.min(last, Math.floor(current)));
    const picked = new Set<number>([cur]);
    if (count <= 3) {
        for (let i = 0; i < count; i++) picked.add(i);
    } else {
        for (const t of [0.2, 0.5, 0.8]) {
            picked.add(Math.round(last * t));
        }
    }
    const rest = [...picked].filter((i) => i !== cur).sort((a, b) => a - b);
    return [cur, ...rest];
}

export function canvasToJpegDataUrl(src: HTMLCanvasElement, maxEdge = 640, quality = 0.86): string {
    const w = src.width;
    const h = src.height;
    if (w < 1 || h < 1) return '';
    const scale = Math.min(1, maxEdge / Math.max(w, h));
    if (scale >= 0.999) return src.toDataURL('image/jpeg', quality);
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(w * scale));
    out.height = Math.max(1, Math.round(h * scale));
    const ctx = out.getContext('2d');
    if (!ctx) return src.toDataURL('image/jpeg', quality);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(src, 0, 0, out.width, out.height);
    return out.toDataURL('image/jpeg', quality);
}

export function captureWebglJpeg(canvas: HTMLCanvasElement | null | undefined): string | null {
    if (!canvas || canvas.width < 8 || canvas.height < 8) return null;
    try {
        const probe = document.createElement('canvas');
        probe.width = 32;
        probe.height = 32;
        const ctx = probe.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(canvas, 0, 0, 32, 32);
        const px = ctx.getImageData(0, 0, 32, 32).data;
        let sum = 0;
        for (let i = 0; i < px.length; i += 4) sum += px[i] + px[i + 1] + px[i + 2];
        if (sum < 32) return null;
        return canvasToJpegDataUrl(canvas, 768, 0.88);
    } catch {
        return null;
    }
}

export function jpegDataUrlSize(dataUrl: string): Promise<{ w: number; h: number }> {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth || img.width, h: img.naturalHeight || img.height });
        img.onerror = () => resolve({ w: 1, h: 1 });
        img.src = dataUrl;
    });
}

import { VolumeData, VolumeCoordSystem } from '../types';
import { metadataFromDicom } from './volumeMetadata';
// @ts-ignore — no official types
import daikon from 'daikon';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DaikonImage = any;

function cross3(a: number[], b: number[]): number[] {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot3(a: number[], b: number[]): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function norm3(v: number[]): number[] {
    const l = Math.sqrt(dot3(v, v)) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
}

function median(values: number[]): number {
    if (values.length === 0) return 1;
    const s = [...values].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function pickLargestSeriesInstance(images: DaikonImage[]): { selected: DaikonImage[]; note: string } {
    const byUid = new Map<string, DaikonImage[]>();
    for (const im of images) {
        const uid = String(im.getSeriesInstanceUID?.() ?? 'UNKNOWN');
        if (!byUid.has(uid)) byUid.set(uid, []);
        byUid.get(uid)!.push(im);
    }
    let best: DaikonImage[] = [];
    for (const arr of byUid.values()) {
        if (arr.length > best.length) best = arr;
    }
    const note =
        byUid.size > 1
            ? `multi_series_input: used largest series (${best.length} images of ${byUid.size} UIDs)`
            : '';
    return { selected: best, note };
}

function geometricSliceSpacingMm(orderedImages: DaikonImage[]): number | null {
    if (orderedImages.length < 2) return null;
    const iop = orderedImages[0].getImageDirections?.();
    if (!iop || iop.length < 6) return null;
    const row = [iop[0], iop[1], iop[2]];
    const col = [iop[3], iop[4], iop[5]];
    let n = norm3(cross3(row, col));

    const ipp0 = orderedImages[0].getImagePosition?.();
    const ipp1 = orderedImages[1].getImagePosition?.();
    if (ipp0?.length === 3 && ipp1?.length === 3) {
        const step = [ipp1[0] - ipp0[0], ipp1[1] - ipp0[1], ipp1[2] - ipp0[2]];
        if (dot3(step, n) < 0) n = [-n[0], -n[1], -n[2]];
    }

    const deltas: number[] = [];
    for (let i = 0; i < orderedImages.length - 1; i++) {
        const a = orderedImages[i].getImagePosition?.();
        const b = orderedImages[i + 1].getImagePosition?.();
        if (!a || !b || a.length < 3 || b.length < 3) continue;
        const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        deltas.push(Math.abs(dot3(d, n)));
    }
    if (deltas.length === 0) return null;
    return median(deltas);
}

/**
 * 4x4 row-major LPS mm: maps voxel centers (i+0.5, j+0.5, k+0.5) with i=column, j=row, k=slice.
 */
function buildLpsAffineFromDicom(
    colDir: number[],
    rowDir: number[],
    sliceDir: number[],
    colSpacing: number,
    rowSpacing: number,
    sliceSpacing: number,
    ippFirstSlice: number[]
): number[] {
    return [
        colSpacing * colDir[0],
        rowSpacing * rowDir[0],
        sliceSpacing * sliceDir[0],
        ippFirstSlice[0],
        colSpacing * colDir[1],
        rowSpacing * rowDir[1],
        sliceSpacing * sliceDir[1],
        ippFirstSlice[1],
        colSpacing * colDir[2],
        rowSpacing * rowDir[2],
        sliceSpacing * sliceDir[2],
        ippFirstSlice[2],
        0,
        0,
        0,
        1
    ];
}

export const parseDicomFiles = (buffers: ArrayBuffer[]): VolumeData | null => {
    if (!buffers || buffers.length === 0) return null;

    const rawImages: DaikonImage[] = [];
    for (const buffer of buffers) {
        try {
            const dataView = new DataView(buffer);
            const image = daikon.Series.parseImage(dataView);
            if (image && image.hasPixelData()) rawImages.push(image);
        } catch (e) {
            console.warn('Failed to parse a DICOM file', e);
        }
    }

    if (rawImages.length === 0) {
        console.error('No valid DICOM images found');
        return null;
    }

    const { selected: seriesImages, note: seriesNote } = pickLargestSeriesInstance(rawImages);

    const series = new daikon.Series();
    for (const im of seriesImages) {
        series.addImage(im);
    }
    series.buildSeries();
    const images = series.images as DaikonImage[];

    if (images.length === 0) return null;

    const first = images[0];
    const rows = first.getRows();
    const cols = first.getCols();
    const depth = images.length;

    const totalSize = rows * cols * depth;
    const data = new Float32Array(totalSize);

    let min = Infinity;
    let max = -Infinity;
    let offset = 0;

    for (let zi = 0; zi < depth; zi++) {
        const img = images[zi];
        const pixels = img.getInterpretedData(false, false);
        for (let j = 0; j < pixels.length; j++) {
            const val = pixels[j];
            data[offset + j] = val;
            if (val < min) min = val;
            if (val > max) max = val;
        }
        offset += pixels.length;
    }

    const spacing = first.getPixelSpacing?.() as number[] | null;
    const rowSpacing = spacing && spacing.length >= 1 ? Number(spacing[0]) || 1 : 1;
    const colSpacing = spacing && spacing.length >= 2 ? Number(spacing[1]) || rowSpacing : rowSpacing;

    const geomSlice = geometricSliceSpacingMm(images);
    const thicknessTag = Number(first.getSliceThickness?.() ?? 0) || 0;
    const sliceSpacing = geomSlice && geomSlice > 1e-6 ? geomSlice : thicknessTag > 0 ? thicknessTag : 1;

    const iop = first.getImageDirections?.() as number[] | null;
    const ipp0 = first.getImagePosition?.() as number[] | null;

    let affine: number[] | undefined;
    const geomParts: string[] = [];
    if (seriesNote) geomParts.push(seriesNote);
    if (geomSlice && geomSlice > 1e-6) geomParts.push('slice_spacing:geometry_median');
    else if (thicknessTag > 0) geomParts.push('slice_spacing:SliceThickness_fallback');
    else geomParts.push('slice_spacing:default_1mm');

    if (iop && iop.length >= 6 && ipp0 && ipp0.length >= 3) {
        const rowDir = norm3([iop[0], iop[1], iop[2]]);
        const colDir = norm3([iop[3], iop[4], iop[5]]);
        let sliceDir = norm3(cross3(rowDir, colDir));
        if (depth > 1) {
            const a = images[0].getImagePosition?.() as number[];
            const b = images[1].getImagePosition?.() as number[];
            if (a?.length === 3 && b?.length === 3) {
                const step = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
                if (dot3(step, sliceDir) < 0) sliceDir = [-sliceDir[0], -sliceDir[1], -sliceDir[2]];
            }
        }
        affine = buildLpsAffineFromDicom(colDir, rowDir, sliceDir, colSpacing, rowSpacing, sliceSpacing, ipp0);
        geomParts.push('affine:IOP_IPP');
    } else {
        geomParts.push('affine:missing_IOP_or_IPP_diagonal_fallback');
        affine = [
            colSpacing,
            0,
            0,
            0,
            0,
            rowSpacing,
            0,
            0,
            0,
            0,
            sliceSpacing,
            0,
            0,
            0,
            0,
            1
        ];
    }

    const coordSystem: VolumeCoordSystem = 'LPS';

    const volume: VolumeData = {
        header: {
            datatypeCode: 16,
            dims: [3, cols, rows, depth, 1, 1, 1, 1],
            pixDims: [1, colSpacing, rowSpacing, sliceSpacing, 0, 0, 0, 0],
            dicomGeometry: { seriesNote: seriesNote || undefined, sliceSpacingMm: sliceSpacing }
        },
        data,
        dimensions: [cols, rows, depth],
        min,
        max,
        affine,
        coordSystem,
        geometryNotes: geomParts.join('; ')
    };
    volume.metadata = metadataFromDicom(first, volume, {
        describe: (group, element) => daikon.Dictionary?.getDescription?.(group, element)
    });
    return volume;
};

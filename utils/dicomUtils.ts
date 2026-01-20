import { VolumeData } from '../types';
// @ts-ignore
import daikon from 'daikon';

export const parseDicomFiles = (buffers: ArrayBuffer[]): VolumeData | null => {
    if (!buffers || buffers.length === 0) return null;

    const series = new daikon.Series();
    let loadedCount = 0;

    // 1. Parse all buffers into images and add to series
    for (const buffer of buffers) {
        try {
            const dataView = new DataView(buffer);
            const image = daikon.Series.parseImage(dataView);
            if (image && image.hasPixelData()) {
                series.addImage(image);
                loadedCount++;
            }
        } catch (e) {
            console.warn("Failed to parse a DICOM file", e);
        }
    }

    if (loadedCount === 0) {
        console.error("No valid DICOM images found");
        return null;
    }

    // 2. Build series (sorts images by position/instance)
    series.buildSeries();
    
    // In some cases daikon concatenates multiple series if found. 
    // We assume the user uploaded one series. If slightly mixed, daikon tries its best.
    const images = series.images;
    
    if (images.length === 0) return null;

    const first = images[0];
    const rows = first.getRows();
    const cols = first.getCols();
    const depth = images.length;
    
    // 3. Extract Pixel Data
    // We assume data is essentially float32 compatible for our viewer
    const totalSize = rows * cols * depth;
    const data = new Float32Array(totalSize);
    
    let min = Infinity;
    let max = -Infinity;
    let offset = 0;

    for (let i = 0; i < depth; i++) {
        const img = images[i];
        // getInterpretedData handles Rescale Slope/Intercept automatically
        const pixels = img.getInterpretedData(false, false); 
        
        for (let j = 0; j < pixels.length; j++) {
            const val = pixels[j];
            data[offset + j] = val;
            if (val < min) min = val;
            if (val > max) max = val;
        }
        offset += pixels.length;
    }

    // 4. Extract Metadata
    const spacing = first.getPixelSpacing(); // returns [rowSpacing, colSpacing]
    const thickness = first.getSliceThickness(); // approximation of Z spacing

    // 5. Construct VolumeData
    // Note: NeuroScan viewer expects [width, height, depth] dimensions
    return {
        header: {
            datatypeCode: 16, // Treat as FLOAT32
            dims: [3, cols, rows, depth, 1, 1, 1, 1],
            pixDims: [1, spacing ? spacing[1] : 1, spacing ? spacing[0] : 1, thickness || 1, 0, 0, 0, 0]
        },
        data: data,
        dimensions: [cols, rows, depth],
        min,
        max
    };
};
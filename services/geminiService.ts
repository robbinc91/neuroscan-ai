import { GoogleGenAI } from "@google/genai";
import { SegmentationStats } from '../types';

/** De-identified exam descriptors only — never patient name, ID, DOB, or accession. */
export interface RadiologyReportContext {
    modality?: string;
    dimensions: [number, number, number];
    spacingMm: [number, number, number];
    coordSystem?: string;
}

export async function hasGeminiApiKey(): Promise<boolean> {
    if (!window.electron) return false;
    const apiKey = await window.electron.store.get('gemini_api_key');
    return typeof apiKey === 'string' && apiKey.length > 0;
}

const getClient = async () => {
    let apiKey: string | undefined;
    if (window.electron) {
        apiKey = await window.electron.store.get('gemini_api_key');
    }
    return new GoogleGenAI({ apiKey: apiKey || 'dummy-key-for-ui-preview' });
};

function formatStatsBlock(stats: SegmentationStats[]): string {
    if (stats.length === 0) return '(no labeled voxels)';
    return stats
        .map(
            (s) =>
                `- ${s.label}: ${s.volume.toFixed(2)} cm³, mean intensity ${s.intensityMean.toFixed(1)}, SD ${s.intensityStd.toFixed(1)}`
        )
        .join('\n');
}

function formatExamBlock(exam?: RadiologyReportContext): string {
    if (!exam) return '';
    const [dx, dy, dz] = exam.dimensions;
    const [sx, sy, sz] = exam.spacingMm;
    const lines = [
        exam.modality ? `- Modality: ${exam.modality}` : null,
        `- Matrix: ${dx} × ${dy} × ${dz}`,
        `- Voxel spacing: ${sx.toFixed(2)} × ${sy.toFixed(2)} × ${sz.toFixed(2)} mm`,
        exam.coordSystem ? `- Coordinate system: ${exam.coordSystem}` : null
    ].filter(Boolean);
    return lines.join('\n');
}

function simulatedReport(stats: SegmentationStats[], exam?: RadiologyReportContext): string {
    const total = stats.reduce((sum, s) => sum + s.volume, 0);
    const findings =
        stats.length === 0
            ? 'No labeled voxels were available for quantitative review.'
            : stats
                  .map((s) => `${s.label} measures ${s.volume.toFixed(2)} cm³ (mean intensity ${s.intensityMean.toFixed(1)}).`)
                  .join(' ');

    return [
        '[SIMULATED DRAFT — NO API KEY CONFIGURED]',
        '',
        'TECHNIQUE',
        'Multi-planar reconstruction and quantitative volumetric analysis of a de-identified MRI volume.',
        exam ? formatExamBlock(exam).replace(/^- /gm, '') : '',
        '',
        'QUANTITATIVE FINDINGS',
        findings,
        stats.length > 0 ? `Total labeled volume ${total.toFixed(2)} cm³.` : '',
        '',
        'IMPRESSION',
        'Draft only. Configure a Gemini API key in Settings to generate a model-assisted report from these measurements.',
        '',
        'Note: Patient identifiers are not included in this draft and are not sent to the model.'
    ]
        .filter((line): line is string => line != null)
        .join('\n');
}

export const generateRadiologyReport = async (
    segmentationStats: SegmentationStats[],
    exam?: RadiologyReportContext
): Promise<string> => {
    if (!(await hasGeminiApiKey())) {
        return new Promise((resolve) => setTimeout(() => resolve(simulatedReport(segmentationStats, exam)), 400));
    }

    const ai = await getClient();
    const total = segmentationStats.reduce((sum, s) => sum + s.volume, 0);

    const prompt = `You are a neuroradiologist writing a concise quantitative draft from measurements only.

Rules:
- Use only the numbers and labels below. Do not invent anatomy, history, or findings that are not supported.
- Do not mention, guess, or request patient name, ID, date of birth, sex, accession number, institution, or dates of service.
- If the data are insufficient for a conclusion, say so.

De-identified exam:
${formatExamBlock(exam) || '- (matrix/spacing not provided)'}

Segmentation volumetry (cm³; intensity is raw voxel value, not calibrated HU unless the source is CT):
${formatStatsBlock(segmentationStats)}
- Total labeled volume: ${total.toFixed(2)} cm³

Structure the draft as plain text with these sections:
1. Technique (multi-planar reconstruction and quantitative analysis)
2. Quantitative Findings
3. Impression (cautious, numbers-based)

This is a decision-support draft, not a signed clinical report.`;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: prompt,
            config: {
                temperature: 0.2,
                maxOutputTokens: 1024
            }
        });

        return response.text || 'Report generation failed: No text returned.';
    } catch (error) {
        console.error('Gemini API Error:', error);
        return 'Error generating report. Check the Gemini API key in Settings.';
    }
};

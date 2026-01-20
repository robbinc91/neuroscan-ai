import { GoogleGenAI } from "@google/genai";
import { MetricData, SegmentationStats } from '../types';

const getClient = async () => {
    // Try to get API key from Electron store if running in desktop app
    let apiKey: string | undefined;

    if (window.electron) {
        apiKey = await window.electron.store.get('gemini_api_key');
    }

    // Fallback to dummy key if no key is available (for UI preview)
    return new GoogleGenAI({ apiKey: apiKey || 'dummy-key-for-ui-preview' });
};

export const generateRadiologyReport = async (
    patientId: string,
    metrics: MetricData[],
    segmentationStats: SegmentationStats[]
): Promise<string> => {
    // Check if API key is available
    let hasApiKey = false;
    if (window.electron) {
        const apiKey = await window.electron.store.get('gemini_api_key');
        hasApiKey = !!apiKey;
    }

    // Fallback for UI preview if no key is present
    if (!hasApiKey) {
        return new Promise(resolve => setTimeout(() => resolve(`
[SIMULATED REPORT - NO API KEY CONFIGURED]

**RADIOLOGICAL QUANTITATIVE REPORT**

**Patient ID:** ${patientId}
**Date:** ${new Date().toLocaleDateString()}

**Technique:**
Multi-planar reconstruction and quantitative volumetric analysis performed.

**Findings:**
Volumetric analysis indicates normal gray matter volume (680 mL) relative to intracranial volume. White matter signal intensity is homogeneous following N4 bias correction. 

No significant asymmetry detected in the ventricular system. The segmentation metrics suggest preservation of hippocampal volume bilaterally.

**Impression:**
Normal brain MRI study based on quantitative volumetrics.

**Note:** This is a simulated report. Please configure your Gemini API key in Settings to enable AI-powered report generation.
        `), 1500));
    }

    const ai = await getClient();

    const prompt = `
    Act as a professional Neuroradiologist. Generate a concise but technical quantitative report based on the following MRI analysis data.
    
    Patient ID: ${patientId}
    
    General Metrics:
    ${metrics.map(m => `- ${m.name}: ${m.value} ${m.unit} (Ref: ${m.reference || 'N/A'})`).join('\n')}
    
    Segmentation Statistics (Volumetric Analysis):
    ${segmentationStats.map(s => `- ${s.label}: ${s.volume.toFixed(1)} cm³, Mean Intensity: ${s.intensityMean.toFixed(1)}`).join('\n')}
    
    Structure the report with:
    1. Technique (mention Multi-planar reconstruction and quantitative analysis)
    2. Quantitative Findings
    3. Impression
    `;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: prompt,
            config: {
                temperature: 0.2, // Low temperature for factual reporting
                maxOutputTokens: 1024,
            }
        });

        return response.text || "Report generation failed: No text returned.";
    } catch (error) {
        console.error("Gemini API Error:", error);
        return "Error generating report. Please check API configuration in Settings.";
    }
};


import { ChartColumn, Activity, Layers, Brain, FileText, Settings, Share2, GitCompare } from 'lucide-react';

export const TOOLS = [
    { id: 'VIEWER', icon: Activity, label: 'Visualization' },
    { id: 'PROCESSING', icon: Settings, label: 'Processing' },
    { id: 'SEGMENTATION', icon: Layers, label: 'Segmentation' },
    { id: 'COMPARISON', icon: GitCompare, label: 'Comparison' },
    { id: 'ANALYSIS', icon: ChartColumn, label: 'Analysis' },
    { id: 'REPORTING', icon: FileText, label: 'Reporting' },
];

export const MOCK_METRICS = [
    { name: 'SNR (White Matter)', value: 45.2, unit: 'dB' },
    { name: 'CNR (GM/WM)', value: 12.8, unit: 'dB' },
    { name: 'Brain Volume', value: 1250, unit: 'cm³', reference: '1100-1300' },
    { name: 'ICV', value: 1450, unit: 'cm³' },
];

export const MOCK_SEG_STATS = [
    { label: 'Gray Matter', volume: 680.5, intensityMean: 450.2, intensityStd: 45.1 },
    { label: 'White Matter', volume: 490.1, intensityMean: 620.8, intensityStd: 32.4 },
    { label: 'CSF', volume: 180.2, intensityMean: 120.5, intensityStd: 15.2 },
    { label: 'Lesions', volume: 0.0, intensityMean: 0.0, intensityStd: 0.0 },
];

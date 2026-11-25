import { ChartColumn, Activity, Layers, FileText, Settings, GitCompare } from 'lucide-react';

export const TOOLS = [
    { id: 'VIEWER', icon: Activity, label: 'Visualization' },
    { id: 'PROCESSING', icon: Settings, label: 'Processing' },
    { id: 'SEGMENTATION', icon: Layers, label: 'Segmentation' },
    { id: 'COMPARISON', icon: GitCompare, label: 'Comparison' },
    { id: 'ANALYSIS', icon: ChartColumn, label: 'Analysis' },
    { id: 'REPORTING', icon: FileText, label: 'Reporting' },
];

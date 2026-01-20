import React, { useState, useEffect, useRef } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { FileText, Download, Share2, Sparkles, Upload, FileJson } from 'lucide-react';
import { MOCK_METRICS } from '../constants';
import { VolumeData, SegmentationStats, ReportImages } from '../types';
import { jsPDF } from "jspdf";
import html2canvas from "html2canvas";

interface AnalysisPanelProps {
    volume: VolumeData | null;
    segmentation: VolumeData | null;
    onGenerateReport?: () => Promise<ReportImages | undefined>;
}

export const AnalysisPanel: React.FC<AnalysisPanelProps> = ({ volume, segmentation, onGenerateReport }) => {
    const [generating, setGenerating] = useState(false);
    const [stats, setStats] = useState<SegmentationStats[]>([]);
    const [labelMapping, setLabelMapping] = useState<Record<string, string>>({});
    const jsonInputRef = useRef<HTMLInputElement>(null);
    const chartRef = useRef<HTMLDivElement>(null);

    // Calculate Segmentation Stats
    useEffect(() => {
        if (!volume || !segmentation) {
            setStats([]);
            return;
        }

        const timer = setTimeout(() => {
            const segData = segmentation.data;
            const volData = volume.data;
            const len = segData.length;

            const counts: Record<number, number> = {};
            const sums: Record<number, number> = {};
            const sqSums: Record<number, number> = {};

            for (let i = 0; i < len; i++) {
                const label = segData[i];
                if (label > 0) {
                    const val = volData[i];
                    counts[label] = (counts[label] || 0) + 1;
                    sums[label] = (sums[label] || 0) + val;
                    sqSums[label] = (sqSums[label] || 0) + (val * val);
                }
            }

            const dims = volume.header.pixDims || [0, 1, 1, 1];
            const spacingX = dims[1] || 1;
            const spacingY = dims[2] || 1;
            const spacingZ = dims[3] || 1;
            const voxelVolMm3 = spacingX * spacingY * spacingZ;

            const computedStats: SegmentationStats[] = Object.keys(counts).map(key => {
                const labelId = Number(key);
                const count = counts[labelId];
                const sum = sums[labelId];
                const sqSum = sqSums[labelId];

                const mean = sum / count;
                const variance = (sqSum / count) - (mean * mean);
                const std = Math.sqrt(Math.max(0, variance));
                const volumeCm3 = (count * voxelVolMm3) / 1000;

                const name = labelMapping[String(labelId)] || `Label ${labelId}`;

                return {
                    label: name,
                    volume: volumeCm3,
                    intensityMean: mean,
                    intensityStd: std
                };
            });

            computedStats.sort((a, b) => {
                const idA = parseInt(a.label.replace('Label ', '')) || 0;
                const idB = parseInt(b.label.replace('Label ', '')) || 0;
                return idA - idB;
            });

            setStats(computedStats);
        }, 100);

        return () => clearTimeout(timer);

    }, [volume, segmentation, labelMapping]);

    const handleGenerateReport = async () => {
        if (stats.length === 0 || !onGenerateReport) return;
        setGenerating(true);

        try {
            // 1. Capture Viewport Images
            const images = await onGenerateReport();

            // 2. Capture Chart
            let chartImgData = '';
            if (chartRef.current) {
                const canvas = await html2canvas(chartRef.current, { backgroundColor: '#111827' });
                chartImgData = canvas.toDataURL('image/png');
            }

            // 3. Generate PDF
            const doc = new jsPDF();
            const pageWidth = doc.internal.pageSize.getWidth();
            const pageHeight = doc.internal.pageSize.getHeight();
            const margin = 15;

            // --- PAGE 1: Summary ---
            doc.setFillColor(15, 23, 42); // bg-slate-900
            doc.rect(0, 0, pageWidth, pageHeight, 'F');

            doc.setTextColor(255, 255, 255);
            doc.setFontSize(22);
            doc.text("NeuroScan AI - Volumetric Analysis Report", margin, 20);

            doc.setFontSize(10);
            doc.setTextColor(148, 163, 184);
            doc.text(`Patient ID: 9382-AC | Date: ${new Date().toLocaleDateString()}`, margin, 30);
            doc.line(margin, 35, pageWidth - margin, 35);

            // Chart
            if (chartImgData) {
                doc.addImage(chartImgData, 'PNG', margin, 45, pageWidth - (margin * 2), 80);
            }

            // Statistics Table
            let yPos = 135;
            doc.setFontSize(12);
            doc.setTextColor(34, 211, 238); // Cyan
            doc.text("Quantitative Statistics", margin, yPos);
            yPos += 10;

            doc.setFontSize(10);
            doc.setTextColor(200, 200, 200);

            // Header
            doc.setFillColor(30, 41, 59);
            doc.rect(margin, yPos - 5, pageWidth - (margin * 2), 8, 'F');
            doc.text("Region", margin + 2, yPos);
            doc.text("Vol (cm³)", margin + 60, yPos);
            doc.text("Mean Int", margin + 100, yPos);
            doc.text("Std Dev", margin + 140, yPos);
            yPos += 10;

            stats.forEach((s) => {
                if (yPos > pageHeight - 20) {
                    doc.addPage();
                    doc.setFillColor(15, 23, 42);
                    doc.rect(0, 0, pageWidth, pageHeight, 'F');
                    yPos = 20;
                }
                doc.text(s.label, margin + 2, yPos);
                doc.text(s.volume.toFixed(2), margin + 60, yPos);
                doc.text(s.intensityMean.toFixed(1), margin + 100, yPos);
                doc.text(s.intensityStd.toFixed(1), margin + 140, yPos);
                yPos += 7;
            });

            // --- PAGE 2: Slices & 3D ---
            if (images) {
                const addImageSection = (title: string, imgs: string[]) => {
                    doc.addPage();
                    doc.setFillColor(15, 23, 42);
                    doc.rect(0, 0, pageWidth, pageHeight, 'F');

                    doc.setFontSize(16);
                    doc.setTextColor(34, 211, 238);
                    doc.text(title, margin, 20);

                    let x = margin;
                    let y = 30;
                    const w = (pageWidth - (margin * 3)) / 2;
                    const h = w; // Square slices

                    imgs.forEach((img, i) => {
                        if (y + h > pageHeight - 10) {
                            doc.addPage();
                            doc.setFillColor(15, 23, 42);
                            doc.rect(0, 0, pageWidth, pageHeight, 'F');
                            y = 30;
                            x = margin;
                        }

                        doc.addImage(img, 'JPEG', x, y, w, h);

                        // Grid logic
                        if (x === margin) {
                            x = margin + w + margin;
                        } else {
                            x = margin;
                            y += h + 10;
                        }
                    });
                };

                if (images.axial.length) addImageSection("Axial Slices", images.axial);
                if (images.coronal.length) addImageSection("Coronal Slices", images.coronal);
                if (images.sagittal.length) addImageSection("Sagittal Slices", images.sagittal);
                if (images.threeD.length) addImageSection("3D Reconstructions", images.threeD);
            }

            doc.save("neuroscan_report.pdf");

        } catch (e) {
            console.error(e);
            alert("Error generating report");
        } finally {
            setGenerating(false);
        }
    };

    const handleJsonUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        try {
            const text = await file.text();
            const mapping = JSON.parse(text);
            if (typeof mapping === 'object') {
                setLabelMapping(mapping);
            } else {
                alert("Invalid JSON format. Expected key-value pairs.");
            }
        } catch (err) {
            console.error(err);
            alert("Failed to parse JSON.");
        }
        if (jsonInputRef.current) jsonInputRef.current.value = '';
    };

    if (!segmentation) {
        return (
            <div className="h-full flex flex-col items-center justify-center p-6 text-center text-gray-500">
                <FileText className="w-12 h-12 mb-4 opacity-20" />
                <p>No Segmentation Mask Loaded.</p>
                <p className="text-xs mt-2">Please load a segmentation file or run segmentation to view analysis.</p>
            </div>
        );
    }

    return (
        <div className="h-full flex flex-col p-4 gap-6 overflow-y-auto">
            <div>
                <div className="flex justify-between items-end mb-3">
                    <h3 className="text-sm font-semibold text-gray-200 uppercase tracking-wider">Volumetric Analysis</h3>
                    <button
                        onClick={() => jsonInputRef.current?.click()}
                        className="text-[10px] flex items-center gap-1 text-cyan-400 hover:text-cyan-300 transition-colors"
                        title="Import JSON Label Mapping ({ '1': 'Hippocampus' })"
                    >
                        <FileJson className="w-3 h-3" /> Map Labels
                    </button>
                    <input type="file" ref={jsonInputRef} onChange={handleJsonUpload} accept=".json" className="hidden" />
                </div>

                {stats.length > 0 ? (
                    <div ref={chartRef} className="h-48 w-full bg-gray-900 rounded-lg p-2 border border-gray-800">
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={stats}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                                <XAxis dataKey="label" fontSize={10} stroke="#9ca3af" tickFormatter={(val) => val.substring(0, 10)} />
                                <YAxis fontSize={10} stroke="#9ca3af" />
                                <Tooltip
                                    contentStyle={{ backgroundColor: '#1f2937', borderColor: '#374151', color: '#f3f4f6' }}
                                    itemStyle={{ color: '#f3f4f6' }}
                                    formatter={(value: number) => [value.toFixed(2), '']}
                                />
                                <Bar dataKey="volume" name="Volume (cm³)" fill="#00a3c4">
                                    {stats.map((entry, index) => (
                                        <Cell key={`cell-${index}`} fill={['#00a3c4', '#a855f7', '#10b981', '#ef4444', '#f59e0b', '#ec4899'][index % 6]} />
                                    ))}
                                </Bar>
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                ) : (
                    <div className="h-48 bg-gray-900 rounded-lg flex items-center justify-center text-xs text-gray-600">
                        No labeled voxels found greater than 0
                    </div>
                )}
            </div>

            <div>
                <h3 className="text-sm font-semibold text-gray-200 mb-3 uppercase tracking-wider">Region Statistics</h3>
                <div className="bg-gray-800 rounded-lg overflow-hidden border border-gray-700">
                    <div className="overflow-x-auto">
                        <table className="w-full text-xs text-left">
                            <thead className="bg-gray-900 text-gray-400">
                                <tr>
                                    <th className="p-2 pl-3">Region / Label</th>
                                    <th className="p-2">Vol (cm³)</th>
                                    <th className="p-2">Mean Int.</th>
                                    <th className="p-2">Std Dev</th>
                                </tr>
                            </thead>
                            <tbody className="text-gray-300">
                                {stats.length === 0 && (
                                    <tr><td colSpan={4} className="p-4 text-center text-gray-600">No data</td></tr>
                                )}
                                {stats.map((s, i) => (
                                    <tr key={i} className="border-t border-gray-700 hover:bg-gray-750/50 transition-colors">
                                        <td className="p-2 pl-3 font-medium text-cyan-100">{s.label}</td>
                                        <td className="p-2 font-mono text-cyan-400">{s.volume.toFixed(2)}</td>
                                        <td className="p-2 text-gray-400">{s.intensityMean.toFixed(1)}</td>
                                        <td className="p-2 text-gray-500">{s.intensityStd.toFixed(1)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>

            <div className="mt-auto">
                <button
                    onClick={handleGenerateReport}
                    disabled={generating || stats.length === 0}
                    className="w-full py-3 mb-4 bg-cyan-700 hover:bg-cyan-600 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg flex items-center justify-center gap-2 transition-all shadow-lg"
                >
                    <Download className={`w-4 h-4 ${generating ? 'animate-bounce' : ''}`} />
                    {generating ? 'Compiling PDF...' : 'Generate Report'}
                </button>
            </div>
        </div>
    );
};
import React from 'react';
import { TOOLS } from '../constants';
import { ToolCategory } from '../types';
import { Brain } from 'lucide-react';

interface SidebarProps {
    activeTool: ToolCategory;
    onSelectTool: (tool: ToolCategory) => void;
    isSegmentationLoaded: boolean;
}

export const Sidebar: React.FC<SidebarProps> = ({ activeTool, onSelectTool, isSegmentationLoaded }) => {
    const visibleTools = TOOLS.filter(tool => {
        if (tool.id === 'ANALYSIS' && !isSegmentationLoaded) {
            return false;
        }
        return true;
    });

    return (
        <div className="w-16 h-full bg-gray-900 border-r border-gray-800 flex flex-col items-center py-4 z-20">
            <div className="mb-8 p-2 bg-cyan-900/20 rounded-xl">
                <Brain className="w-8 h-8 text-cyan-400" />
            </div>
            
            <div className="flex flex-col gap-4 w-full px-2">
                {visibleTools.map((tool) => {
                    const Icon = tool.icon;
                    const isActive = activeTool === tool.id;
                    
                    return (
                        <button
                            key={tool.id}
                            onClick={() => onSelectTool(tool.id as ToolCategory)}
                            className={`
                                group relative p-3 rounded-lg transition-all duration-200
                                ${isActive 
                                    ? 'bg-cyan-900/30 text-cyan-400' 
                                    : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
                                }
                            `}
                            title={tool.label}
                        >
                            <Icon className="w-6 h-6" />
                            {isActive && (
                                <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-8 bg-cyan-400 rounded-r-full" />
                            )}
                        </button>
                    );
                })}
            </div>

            <div className="mt-auto mb-4">
                 {/* Bottom actions if needed */}
            </div>
        </div>
    );
};
import React, { useState, useEffect } from 'react';
import { X, Key, Folder, Info, Check, AlertCircle } from 'lucide-react';

interface SettingsDialogProps {
    isOpen: boolean;
    onClose: () => void;
}

export const SettingsDialog: React.FC<SettingsDialogProps> = ({ isOpen, onClose }) => {
    const [apiKey, setApiKey] = useState('');
    const [savedApiKey, setSavedApiKey] = useState('');
    const [defaultPath, setDefaultPath] = useState('');
    const [appVersion, setAppVersion] = useState('');
    const [isSaving, setIsSaving] = useState(false);
    const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');

    useEffect(() => {
        if (isOpen) {
            loadSettings();
        }
    }, [isOpen]);

    const loadSettings = async () => {
        try {
            // Load saved API key from encrypted store
            const storedKey = await window.electron.store.get('gemini_api_key');
            if (storedKey) {
                setSavedApiKey(storedKey);
                setApiKey('•'.repeat(20)); // Mask the key for security
            }

            // Load default path
            const storedPath = await window.electron.store.get('default_file_path');
            if (storedPath) {
                setDefaultPath(storedPath);
            } else {
                const downloadsPath = await window.electron.getAppPath('downloads');
                setDefaultPath(downloadsPath);
            }

            // Get app version
            const version = await window.electron.getAppVersion();
            setAppVersion(version);
        } catch (error) {
            console.error('Error loading settings:', error);
        }
    };

    const handleSave = async () => {
        setIsSaving(true);
        setSaveStatus('idle');

        try {
            // Only save API key if it's not the masked value
            if (apiKey && !apiKey.startsWith('•')) {
                await window.electron.store.set('gemini_api_key', apiKey);
                setSavedApiKey(apiKey);
            }

            // Save default path
            if (defaultPath) {
                await window.electron.store.set('default_file_path', defaultPath);
            }

            setSaveStatus('success');
            setTimeout(() => {
                setSaveStatus('idle');
                setApiKey('•'.repeat(20)); // Mask the key again after saving
            }, 2000);
        } catch (error) {
            console.error('Error saving settings:', error);
            setSaveStatus('error');
            setTimeout(() => setSaveStatus('idle'), 3000);
        } finally {
            setIsSaving(false);
        }
    };

    const handleBrowseFolder = async () => {
        try {
            const result = await window.electron.openFileDialog({
                properties: ['openDirectory' as any]
            });
            if (result && result.length > 0) {
                setDefaultPath(result[0].path);
            }
        } catch (error) {
            console.error('Error selecting folder:', error);
        }
    };

    const handleClearApiKey = async () => {
        try {
            await window.electron.store.delete('gemini_api_key');
            setApiKey('');
            setSavedApiKey('');
            setSaveStatus('success');
            setTimeout(() => setSaveStatus('idle'), 2000);
        } catch (error) {
            console.error('Error clearing API key:', error);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
            <div className="bg-gray-900 rounded-lg shadow-2xl w-[600px] max-h-[80vh] overflow-hidden border border-gray-800">
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
                    <h2 className="text-xl font-semibold text-gray-100">Settings</h2>
                    <button
                        onClick={onClose}
                        className="text-gray-400 hover:text-gray-200 transition-colors"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* Content */}
                <div className="p-6 space-y-6 overflow-y-auto max-h-[calc(80vh-140px)]">
                    {/* API Key Section */}
                    <div className="space-y-3">
                        <div className="flex items-center gap-2 text-gray-200">
                            <Key className="w-4 h-4" />
                            <h3 className="font-medium">Gemini API Key</h3>
                        </div>
                        <p className="text-sm text-gray-400">
                            Enter your Google Gemini API key for AI-powered analysis features.
                        </p>
                        <div className="space-y-2">
                            <input
                                type="password"
                                value={apiKey}
                                onChange={(e) => setApiKey(e.target.value)}
                                placeholder="Enter your API key..."
                                className="w-full px-4 py-2 bg-gray-800 border border-gray-700 rounded text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-transparent"
                            />
                            {savedApiKey && (
                                <div className="flex items-center gap-2 text-xs text-green-400">
                                    <Check className="w-3 h-3" />
                                    <span>API key is currently saved</span>
                                    <button
                                        onClick={handleClearApiKey}
                                        className="ml-auto text-red-400 hover:text-red-300 underline"
                                    >
                                        Clear
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Default Path Section */}
                    <div className="space-y-3">
                        <div className="flex items-center gap-2 text-gray-200">
                            <Folder className="w-4 h-4" />
                            <h3 className="font-medium">Default File Path</h3>
                        </div>
                        <p className="text-sm text-gray-400">
                            Default directory for opening and saving medical image files.
                        </p>
                        <div className="flex gap-2">
                            <input
                                type="text"
                                value={defaultPath}
                                onChange={(e) => setDefaultPath(e.target.value)}
                                placeholder="Select default path..."
                                className="flex-1 px-4 py-2 bg-gray-800 border border-gray-700 rounded text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-transparent"
                            />
                            <button
                                onClick={handleBrowseFolder}
                                className="px-4 py-2 bg-gray-800 border border-gray-700 rounded text-gray-100 hover:bg-gray-700 transition-colors"
                            >
                                Browse
                            </button>
                        </div>
                    </div>

                    {/* App Info Section */}
                    <div className="space-y-3 pt-4 border-t border-gray-800">
                        <div className="flex items-center gap-2 text-gray-200">
                            <Info className="w-4 h-4" />
                            <h3 className="font-medium">Application Info</h3>
                        </div>
                        <div className="grid grid-cols-2 gap-4 text-sm">
                            <div>
                                <span className="text-gray-400">Version:</span>
                                <span className="ml-2 text-gray-100">{appVersion || 'Loading...'}</span>
                            </div>
                            <div>
                                <span className="text-gray-400">Platform:</span>
                                <span className="ml-2 text-gray-100">Electron</span>
                            </div>
                        </div>
                    </div>

                    {/* Save Status */}
                    {saveStatus !== 'idle' && (
                        <div className={`flex items-center gap-2 p-3 rounded ${saveStatus === 'success'
                            ? 'bg-green-900/30 text-green-400 border border-green-800'
                            : 'bg-red-900/30 text-red-400 border border-red-800'
                            }`}>
                            {saveStatus === 'success' ? (
                                <>
                                    <Check className="w-4 h-4" />
                                    <span className="text-sm">Settings saved successfully!</span>
                                </>
                            ) : (
                                <>
                                    <AlertCircle className="w-4 h-4" />
                                    <span className="text-sm">Error saving settings. Please try again.</span>
                                </>
                            )}
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-800 bg-gray-900">
                    <button
                        onClick={onClose}
                        className="px-4 py-2 text-gray-300 hover:text-gray-100 transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={isSaving}
                        className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                    >
                        {isSaving ? (
                            <>
                                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                Saving...
                            </>
                        ) : (
                            <>
                                <Check className="w-4 h-4" />
                                Save Settings
                            </>
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
};

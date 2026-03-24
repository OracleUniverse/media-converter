import React, { useState, useRef } from 'react';
import { AudioLines, Video, Loader2, Download, AlertCircle, CheckCircle2, FileText, Copy, Cpu } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { audioProcessor } from '../../lib/audioProcessor';

interface MediaTranscriberProps {
    userId: string;
}

export const MediaTranscriber = ({ userId }: MediaTranscriberProps) => {
    const [file, setFile] = useState<File | null>(null);
    const [status, setStatus] = useState<'idle' | 'preparing' | 'processing' | 'success' | 'error'>('idle');
    const [processStep, setProcessStep] = useState<'converting' | 'uploading' | 'transcribing' | 'idle'>('idle');
    const [chunkProgress, setChunkProgress] = useState({ current: 0, total: 0 });
    const [errorMsg, setErrorMsg] = useState<string>('');
    const [transcription, setTranscription] = useState<string>('');
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const selected = e.target.files?.[0];
        if (selected && (selected.type.startsWith('audio/') || selected.type.startsWith('video/'))) {
            setFile(selected);
            setStatus('idle');
            setProcessStep('idle');
            setErrorMsg('');
            setTranscription('');
            setChunkProgress({ current: 0, total: 0 });
        } else {
            setErrorMsg('Please select a valid audio or video file.');
        }
    };

    const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        const dropped = e.dataTransfer.files?.[0];
        if (dropped && (dropped.type.startsWith('audio/') || dropped.type.startsWith('video/'))) {
            setFile(dropped);
            setStatus('idle');
            setProcessStep('idle');
            setErrorMsg('');
            setTranscription('');
            setChunkProgress({ current: 0, total: 0 });
        }
    };

    const handleTranscribe = async () => {
        if (!file) return;

        try {
            console.log(`[MEDIA TRANSCRIBER] 🚩 Starting optimized process for: ${file.name}`);
            setStatus('preparing');
            
            // 1. Browser-side Conversion to MP3
            setProcessStep('converting');
            console.log(`[MEDIA TRANSCRIBER] 🔄 Extracting and compressing audio...`);
            const processedAudio = await audioProcessor.processMedia(file);
            console.log(`[MEDIA TRANSCRIBER] ✅ Conversion complete. New size: ${(processedAudio.size / 1024 / 1024).toFixed(2)} MB`);

            // 2. Duration Check & Chunking
            const duration = await audioProcessor.getDuration(processedAudio);
            const chunks = await audioProcessor.sliceAudio(processedAudio, duration);
            setChunkProgress({ current: 0, total: chunks.length });
            
            let fullTranscription = '';
            
            // 3. Process each chunk
            for (let i = 0; i < chunks.length; i++) {
                const chunk = chunks[i];
                setChunkProgress({ current: i + 1, total: chunks.length });
                
                // Upload Chunk
                setProcessStep('uploading');
                const safeName = file.name.replace(/[^a-zA-Z0-9.-]/g, '_').replace(/\.[^/.]+$/, "");
                const chunkPath = `${userId}/chunks/${Date.now()}_${safeName}_part${i+1}.mp3`;
                
                console.log(`[MEDIA TRANSCRIBER] ⬆️ Uploading chunk ${i+1}/${chunks.length}`);
                const { error: uploadError } = await supabase.storage.from('trans_media_assets').upload(chunkPath, chunk.blob);
                if (uploadError) throw new Error(`Failed to upload chunk ${i+1}: ` + uploadError.message);

                // Transcribe Chunk
                setProcessStep('transcribing');
                setStatus('processing');
                console.log(`[MEDIA TRANSCRIBER] 🚀 Transcribing chunk ${i+1}...`);
                
                const { data: { session } } = await supabase.auth.getSession();
                const { data, error } = await supabase.functions.invoke('transcribe-media', {
                    headers: { Authorization: `Bearer ${session?.access_token}` },
                    body: {
                        filePath: chunkPath,
                        mimeType: 'audio/mpeg',
                        originalFileName: file.name,
                        fileSize: file.size,
                        duration: duration,
                        chunkIndex: i + 1,
                        totalChunks: chunks.length,
                        model: 'google/gemini-2.0-flash-001'
                    }
                });

                if (error || !data?.success) {
                    const msg = data?.error || error?.message || `Chunk ${i+1} transcription failed.`;
                    throw new Error(msg);
                }

                fullTranscription += (fullTranscription ? '\n\n' : '') + data.transcription;
            }

            // 4. Save History (Final Result)
            const IS_GUEST = userId === '00000000-0000-0000-0000-000000000000';
            if (!IS_GUEST) {
                try {
                    await supabase.from('conv_documents').insert({
                        user_id: userId,
                        original_file_path: file.name,
                        status: 'completed'
                    });
                } catch (dbErr) {
                    console.warn("[MEDIA TRANSCRIBER] ⚠️ History logging skipped.", dbErr);
                }
            }

            setTranscription(fullTranscription);
            setStatus('success');
            setProcessStep('idle');
            console.log(`[MEDIA TRANSCRIBER] ✅ All done!`);

        } catch (err: any) {
            console.error("[MEDIA TRANSCRIBER] ❌ Fatal Error:", err);
            setErrorMsg(err.message || "An unknown error occurred.");
            setStatus('error');
            setProcessStep('idle');
        }
    };

    const handleDownload = () => {
        if (!transcription) return;
        const blob = new Blob([transcription], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${file?.name.replace(/\.[^/.]+$/, "")}_transcription.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const copyToClipboard = () => {
        navigator.clipboard.writeText(transcription);
    };

    return (
        <div className="max-w-4xl mx-auto py-12">
            <div className="text-center mb-10">
                <h1 className="text-4xl font-black tracking-tight gradient-text mb-4">Media Intelligence Transcriber</h1>
                <p className="text-(--text-secondary) max-w-2xl mx-auto">
                    Upload your Audio or Video files. Powered by Gemini, we natively understand and transcribe speech and visual contexts with human-level accuracy.
                </p>
            </div>

            <div className="bg-(--card-bg) border border-(--border-subtle) rounded-3xl p-8 shadow-xl">
                {!file ? (
                    <div 
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={handleDrop}
                        onClick={() => fileInputRef.current?.click()}
                        className="border-2 border-dashed border-(--border-subtle) hover:border-purple-500/50 rounded-2xl p-16 flex flex-col items-center justify-center cursor-pointer transition-all bg-(--bg-glass) group"
                    >
                        <div className="flex gap-4 mb-6 group-hover:scale-110 transition-transform">
                            <div className="w-14 h-14 rounded-full bg-blue-500/10 flex items-center justify-center">
                                <AudioLines size={24} className="text-blue-400" />
                            </div>
                            <div className="w-14 h-14 rounded-full bg-purple-500/10 flex items-center justify-center">
                                <Video size={24} className="text-purple-400" />
                            </div>
                        </div>
                        <h3 className="text-lg font-bold text-(--text-primary) mb-2">Drop Media File Here</h3>
                        <p className="text-sm text-(--text-muted) text-center max-w-sm">
                            Supports MP3, WAV, MP4, MOV, MPEG. (Keep under 50MB for best results)
                        </p>
                        <input 
                            type="file" 
                            accept="audio/*,video/*" 
                            className="hidden" 
                            ref={fileInputRef} 
                            onChange={handleFileSelect}
                        />
                    </div>
                ) : (
                    <div className="space-y-8">
                        {/* File Preview Card */}
                        <div className="flex items-center p-4 bg-(--bg-glass) border border-(--border-subtle) rounded-xl">
                            <div className="w-12 h-12 rounded-lg bg-blue-500/10 flex items-center justify-center shrink-0">
                                {file.type.startsWith('video/') ? (
                                    <Video size={24} className="text-purple-400" />
                                ) : (
                                    <AudioLines size={24} className="text-blue-400" />
                                )}
                            </div>
                            <div className="ml-4 flex-1 overflow-hidden">
                                <h4 className="font-bold text-(--text-primary) truncate">{file.name}</h4>
                                <p className="text-xs text-(--text-muted)">
                                    {(file.size / 1024 / 1024).toFixed(2)} MB • {file.type || 'Media File'}
                                </p>
                            </div>
                            {status === 'idle' && (
                                <button 
                                    onClick={() => setFile(null)}
                                    className="ml-4 p-2 text-(--text-muted) hover:text-red-400 transition-colors"
                                >
                                    Cancel
                                </button>
                            )}
                        </div>

                        {/* Status & Actions */}
                        <div className="flex flex-col items-center justify-center pt-4">
                            {status === 'idle' && (
                                <button 
                                    onClick={handleTranscribe}
                                    className="btn-primary w-full md:w-auto px-12 py-4 text-sm font-bold tracking-widest uppercase flex items-center justify-center gap-2 bg-linear-to-r from-purple-500 to-indigo-600 hover:from-purple-600 hover:to-indigo-700 border-none"
                                >
                                    <FileText size={18} />
                                    Start Transcription
                                </button>
                            )}

                            {status === 'preparing' && (
                                <div className="flex flex-col items-center text-indigo-400">
                                    <Loader2 size={32} className="animate-spin mb-3" />
                                    <p className="font-bold tracking-wide animate-pulse">
                                        {processStep === 'converting' ? 'Optimizing Media (Offline)...' : 'Uploading chunk...'}
                                    </p>
                                    <p className="text-xs text-(--text-muted) mt-2">
                                        {processStep === 'converting' 
                                            ? 'Extracting high-quality audio for faster processing'
                                            : `Preparing part ${chunkProgress.current} of ${chunkProgress.total}`}
                                    </p>
                                </div>
                            )}

                            {status === 'processing' && (
                                <div className="flex flex-col items-center text-purple-400">
                                    <div className="relative w-16 h-16 mb-4">
                                        <div className="absolute inset-0 border-4 border-purple-500/20 rounded-full"></div>
                                        <div className="absolute inset-0 border-4 border-purple-500 rounded-full border-t-transparent animate-spin"></div>
                                        <Cpu className="absolute inset-0 m-auto" size={24} />
                                    </div>
                                    <p className="font-bold tracking-wide">
                                        {chunkProgress.total > 1 
                                            ? `AI Transcribing: Part ${chunkProgress.current} of ${chunkProgress.total}`
                                            : 'AI Engine is analyzing speech...'}
                                    </p>
                                    {chunkProgress.total > 1 && (
                                        <div className="w-48 h-1.5 bg-purple-500/20 rounded-full mt-4 overflow-hidden">
                                            <div 
                                                className="h-full bg-purple-500 transition-all duration-500" 
                                                style={{ width: `${(chunkProgress.current / chunkProgress.total) * 100}%` }}
                                            />
                                        </div>
                                    )}
                                    <p className="text-xs text-(--text-muted) mt-4">This usually takes 10-30 seconds per part.</p>
                                </div>
                            )}

                            {status === 'error' && (
                                <div className="flex flex-col items-center w-full">
                                    <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl text-red-500 flex items-start gap-3 w-full mb-6">
                                        <AlertCircle size={20} className="shrink-0 mt-0.5" />
                                        <div>
                                            <h4 className="font-bold mb-1">Transcription Failed</h4>
                                            <p className="text-sm opacity-90">{errorMsg}</p>
                                        </div>
                                    </div>
                                    <button 
                                        onClick={() => setStatus('idle')}
                                        className="btn-secondary px-8 py-3"
                                    >
                                        Try Again
                                    </button>
                                </div>
                            )}

                            {status === 'success' && (
                                <div className="flex flex-col items-center w-full animate-in fade-in zoom-in duration-300">
                                    <div className="w-16 h-16 bg-emerald-500/10 rounded-full flex items-center justify-center mb-4">
                                        <CheckCircle2 size={32} className="text-emerald-500" />
                                    </div>
                                    <h3 className="text-xl font-black text-(--text-primary) mb-6">Transcription Complete</h3>
                                    
                                    <div className="w-full bg-(--bg-main) rounded-xl border border-(--border-subtle) p-6 mb-8 text-left max-h-96 overflow-y-auto relative group">
                                        <button 
                                            onClick={copyToClipboard}
                                            className="absolute top-4 right-4 p-2 bg-(--card-bg) hover:bg-(--border-subtle) hover:text-white rounded-lg transition-colors border border-(--border-subtle) shadow-sm opacity-0 group-hover:opacity-100 cursor-pointer"
                                            title="Copy to clipboard"
                                        >
                                            <Copy size={16} />
                                        </button>
                                        <div className="prose prose-sm prose-invert max-w-none">
                                            {transcription.split('\n').map((paragraph, idx) => (
                                                <p key={idx} className="mb-2 text-(--text-secondary)">{paragraph}</p>
                                            ))}
                                        </div>
                                    </div>
                                    
                                    <div className="flex gap-4">
                                        <button 
                                            onClick={handleDownload}
                                            className="btn-primary px-8 py-3 flex items-center gap-2"
                                        >
                                            <Download size={18} />
                                            Download .txt
                                        </button>
                                        <button 
                                            onClick={() => { setFile(null); setStatus('idle'); setTranscription(''); }}
                                            className="btn-secondary px-6 py-3"
                                        >
                                            Transcribe Another
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

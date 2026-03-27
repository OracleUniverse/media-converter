import React, { useState, useRef } from 'react';
import { FileUp, FileText, Loader2, Download, AlertCircle, CheckCircle2 } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { splitPdfIntoImages, extractSpatialMetadata } from '../../lib/pdf';

interface DocumentConverterProps {
    userId: string;
}

export const DocumentConverter = ({ userId }: DocumentConverterProps) => {
    const [file, setFile] = useState<File | null>(null);
    const [status, setStatus] = useState<'idle' | 'preparing' | 'processing' | 'success' | 'error'>('idle');
    const [errorMsg, setErrorMsg] = useState<string>('');
    const [downloadUrl, setDownloadUrl] = useState<string>('');
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const selected = e.target.files?.[0];
        if (selected && selected.type === 'application/pdf') {
            setFile(selected);
            setStatus('idle');
            setErrorMsg('');
            setDownloadUrl('');
        } else {
            setErrorMsg('Please select a valid PDF file.');
        }
    };

    const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        const dropped = e.dataTransfer.files?.[0];
        if (dropped && dropped.type === 'application/pdf') {
            setFile(dropped);
            setStatus('idle');
            setErrorMsg('');
            setDownloadUrl('');
        }
    };

    const handleConvert = async () => {
        if (!file) return;

        try {
            setStatus('preparing');
            
            // 1. Prepare PDF assets (Images + Spatial Map)
            setStatus('preparing');
            const [imageFiles, spatialMetadata] = await Promise.all([
                splitPdfIntoImages(file),
                extractSpatialMetadata(file)
            ]);
            
            const base64Images = await Promise.all(imageFiles.map(async (img) => {
                const buffer = await img.arrayBuffer();
                const base64 = btoa(new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), ''));
                return { mimeType: img.type, data: base64 };
            }));
            
            // 2. Upload Original PDF (Async background)
            // Sanitize file name to avoid 400 Bad Request on Storage upload
            const safeName = file.name.replace(/[^\x20-\x7E]/g, '_').replace(/[^a-zA-Z0-9.-]/g, '_').replace(/_{2,}/g, '_');
            const originalPath = `${userId}/orig_${Date.now()}_${safeName}`;
            
            console.log(`[STORAGE] ⬆️ Uploading original PDF to: ${originalPath}`);
            const { error: storageError } = await supabase.storage.from('conv_files').upload(originalPath, file);
            
            if (storageError) {
                console.error("[STORAGE] ❌ Upload failed:", storageError);
                // We'll continue anyway because the main conversion uses the base64Images payload,
                // but this helps us see exactly WHY it's 400 (e.g. "Bucket not found")
            }

            // 3. Invoke Edge Function
            setStatus('processing');
            const { data: { session } } = await supabase.auth.getSession();
            
            const { data, error } = await supabase.functions.invoke('convert-pdf-word', {
                headers: {
                    Authorization: `Bearer ${session?.access_token}`,
                },
                body: {
                    userId: userId, 
                    images: base64Images,
                    spatialMetadata,
                    originalFileName: safeName.replace(/\.[^/.]+$/, ""),
                    model: 'google/gemini-2.0-flash-001'
                }
            });

            if (error || !data?.success) {
                throw new Error(error?.message || data?.error || 'Conversion failed at edge layer.');
            }
            
            // Log debug info to web console
            if (data.debug) {
                console.group("=== AI CONVERTER DEBUG LOGS ===");
                console.log("🛠 Model Used:", data.debug.model);
                console.log("📝 Prompt Sent:", data.debug.prompt);
                console.log("🤖 Raw AI Output Format:", data.debug.rawAiOutput);
                console.groupEnd();
            }

            // 4. Generate Download URL
            const { data: urlData, error: urlError } = await supabase.storage
                .from('conv_files')
                .createSignedUrl(data.filePath, 3600); // 1 hour link

            if (urlError) throw urlError;

            // 5. Save History
            await supabase.from('conv_documents').insert({
                user_id: userId,
                original_file_path: originalPath,
                converted_file_path: data.filePath,
                status: 'completed'
            });

            setDownloadUrl(urlData.signedUrl);
            setStatus('success');

        } catch (err: any) {
            console.error("Conversion Error:", err);
            setErrorMsg(err.message || "An unknown error occurred during conversion.");
            setStatus('error');
        }
    };

    return (
        <div className="max-w-4xl mx-auto py-12">
            <div className="text-center mb-10">
                <h1 className="text-4xl font-black tracking-tight gradient-text mb-4">AI PDF to Word Converter</h1>
                <p className="text-(--text-secondary) max-w-2xl mx-auto">
                    Transform standard PDFs into fully styled, editable Word documents. Our AI engine extracts layouts, fonts, and tables, preserving the visual hierarchy of your original file.
                </p>
            </div>

            <div className="bg-(--card-bg) border border-(--border-subtle) rounded-3xl p-8 shadow-xl">
                {!file ? (
                    <div 
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={handleDrop}
                        onClick={() => fileInputRef.current?.click()}
                        className="border-2 border-dashed border-(--border-subtle) hover:border-indigo-500/50 rounded-2xl p-16 flex flex-col items-center justify-center cursor-pointer transition-all bg-(--bg-glass) group"
                    >
                        <div className="w-16 h-16 rounded-full bg-indigo-500/10 flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                            <FileUp size={28} className="text-indigo-400" />
                        </div>
                        <h3 className="text-lg font-bold text-(--text-primary) mb-2">Upload a PDF to convert</h3>
                        <p className="text-sm text-(--text-muted) text-center max-w-sm">
                            Drag and drop your PDF file here, or click to browse. Maximum file length is 10 pages for optimal AI processing.
                        </p>
                        <input 
                            type="file" 
                            accept=".pdf" 
                            className="hidden" 
                            ref={fileInputRef} 
                            onChange={handleFileSelect}
                        />
                    </div>
                ) : (
                    <div className="space-y-8">
                        {/* File Preview Card */}
                        <div className="flex items-center p-4 bg-(--bg-glass) border border-(--border-subtle) rounded-xl">
                            <div className="w-12 h-12 rounded-lg bg-red-500/10 flex items-center justify-center shrink-0">
                                <FileText size={24} className="text-red-400" />
                            </div>
                            <div className="ml-4 flex-1 overflow-hidden">
                                <h4 className="font-bold text-(--text-primary) truncate">{file.name}</h4>
                                <p className="text-xs text-(--text-muted)">
                                    {(file.size / 1024 / 1024).toFixed(2)} MB • PDF Document
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
                                    onClick={handleConvert}
                                    className="btn-primary w-full md:w-auto px-12 py-4 text-sm font-bold tracking-widest uppercase flex items-center justify-center gap-2"
                                >
                                    <FileText size={18} />
                                    Convert to Word Magic
                                </button>
                            )}

                            {status === 'preparing' && (
                                <div className="flex flex-col items-center text-indigo-400 animate-pulse">
                                    <Loader2 size={32} className="animate-spin mb-3" />
                                    <p className="font-bold tracking-wide">Preparing document (Reading PDF)...</p>
                                </div>
                            )}

                            {status === 'processing' && (
                                <div className="flex flex-col items-center text-purple-400">
                                    <div className="relative w-16 h-16 mb-4">
                                        <div className="absolute inset-0 border-4 border-purple-500/20 rounded-full"></div>
                                        <div className="absolute inset-0 border-4 border-purple-500 rounded-full border-t-transparent animate-spin"></div>
                                        <FileText className="absolute inset-0 m-auto" size={24} />
                                    </div>
                                    <p className="font-bold tracking-wide">AI Engine is reconstructing layout & formatting...</p>
                                    <p className="text-xs text-(--text-muted) mt-2">This may take a minute for complex documents.</p>
                                </div>
                            )}

                            {status === 'error' && (
                                <div className="flex flex-col items-center w-full">
                                    <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl text-red-500 flex items-start gap-3 w-full mb-6">
                                        <AlertCircle size={20} className="shrink-0 mt-0.5" />
                                        <div>
                                            <h4 className="font-bold mb-1">Conversion Failed</h4>
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
                                <div className="flex flex-col items-center animate-in fade-in zoom-in duration-300">
                                    <div className="w-20 h-20 bg-emerald-500/10 rounded-full flex items-center justify-center mb-6">
                                        <CheckCircle2 size={40} className="text-emerald-500" />
                                    </div>
                                    <h3 className="text-2xl font-black text-(--text-primary) mb-2">Conversion Complete!</h3>
                                    <p className="text-(--text-secondary) mb-8 text-center">
                                        Your document has been successfully converted to Word format.
                                    </p>
                                    
                                    <div className="flex gap-4">
                                        <a 
                                            href={downloadUrl} 
                                            download 
                                            className="btn-primary px-8 py-3 flex items-center gap-2"
                                        >
                                            <Download size={18} />
                                            Download .docx
                                        </a>
                                        <button 
                                            onClick={() => { setFile(null); setStatus('idle'); }}
                                            className="btn-secondary px-6 py-3"
                                        >
                                            Convert Another
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

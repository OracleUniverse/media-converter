import React, { useState, useRef } from 'react';
import { FileUp, FileText, Loader2, Download, AlertCircle, CheckCircle2 } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { splitPdfIntoImages, extractSpatialMetadata } from '../../lib/pdf';

interface DocumentConverterProps {
    userId: string;
}

export const DocumentConverter = ({ userId }: DocumentConverterProps) => {
    const [file, setFile] = useState<File | null>(null);
    const [status, setStatus] = useState<'idle' | 'preparing' | 'processing' | 'reconstructing-html' | 'success' | 'error'>('idle');
    const [errorMsg, setErrorMsg] = useState<string>('');
    const [usePythonEngine, setUsePythonEngine] = useState<boolean>(true);
    const [downloadUrl, setDownloadUrl] = useState<string>('');
    const [htmlDownloadUrl, setHtmlDownloadUrl] = useState<string>('');
    const [reconstructedHtml, setReconstructedHtml] = useState<string>('');
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const selected = e.target.files?.[0];
        if (selected && selected.type === 'application/pdf') {
            setFile(selected);
            setStatus('idle');
            setErrorMsg('');
            setDownloadUrl('');
            setHtmlDownloadUrl('');
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
            setHtmlDownloadUrl('');
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
            
            let data, error;
            
            if (usePythonEngine) {
                // HIGH FIDELITY (PYTHON)
                console.log("🚀 Using Python Engine (Localhost)...");
                const formData = new FormData();
                formData.append('file', file);
                
                const response = await fetch('http://localhost:8000/convert', {
                    method: 'POST',
                    body: formData
                });
                
                const res = await response.json();
                if (!res.success) throw new Error(res.error || "Python Engine Error");
                
                // Python returns base64 content, we convert to Blob
                const byteCharacters = atob(res.content);
                const byteNumbers = new Array(byteCharacters.length);
                for (let i = 0; i < byteCharacters.length; i++) {
                    byteNumbers[i] = byteCharacters.charCodeAt(i);
                }
                const byteArray = new Uint8Array(byteNumbers);
                const blob = new Blob([byteArray], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
                
                let htmlBlob = null;
                if (res.html_content) {
                    const htmlBytes = atob(res.html_content);
                    const htmlByteArray = new Uint8Array(htmlBytes.length);
                    for (let i = 0; i < htmlBytes.length; i++) htmlByteArray[i] = htmlBytes.charCodeAt(i);
                    htmlBlob = new Blob([htmlByteArray], { type: 'text/html' });
                }

                data = { 
                    success: true, 
                    filePath: `local/${res.filename}`,
                    isLocal: true,
                    localBlob: blob,
                    htmlBlob: htmlBlob,
                    htmlFilename: res.html_filename,
                    debug: res.debug
                };
            } else {
                // STANDARD (SUPABASE)
                const { data: res, error: resErr } = await supabase.functions.invoke('convert-pdf-word', {
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
                data = res;
                error = resErr;
            }

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

            if (data.isLocal) {
                setDownloadUrl(URL.createObjectURL(data.localBlob));
                if (data.htmlBlob) {
                    setHtmlDownloadUrl(URL.createObjectURL(data.htmlBlob));
                }
            } else {
                const { data: urlData, error: urlError } = await supabase.storage
                    .from('conv_files')
                    .createSignedUrl(data.filePath, 3600);
                if (urlError) throw urlError;
                setDownloadUrl(urlData.signedUrl);
            }
            
            setStatus('success');

        } catch (err: any) {
            console.error("Conversion Error:", err);
            setErrorMsg(err.message || "An unknown error occurred during conversion.");
            setStatus('error');
        }
    };

    const handleHtmlReconstruct = async () => {
        if (!file) return;

        try {
            setStatus('preparing');
            
            // 1. Prepare PDF assets (Images in Color)
            const imageFiles = await splitPdfIntoImages(file, 0.85, 0.7, true);
            
            const base64Images = await Promise.all(imageFiles.map(async (img) => {
                const buffer = await img.arrayBuffer();
                const base64 = btoa(new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), ''));
                return { mimeType: img.type, data: base64 };
            }));
            
            // 2. Invoke Reconstruction Edge Function
            setStatus('reconstructing-html');
            const { data: { session } } = await supabase.auth.getSession();
            
            const { data, error } = await supabase.functions.invoke('reconstruct-pdf-html', {
                headers: {
                    Authorization: `Bearer ${session?.access_token}`,
                },
                body: {
                    images: base64Images,
                    model: 'google/gemini-2.0-flash-001'
                }
            });

            if (error || !data?.success) {
                throw new Error(error?.message || data?.error || 'HTML Reconstruction failed.');
            }
            
            // 3. Prepare Download
            const htmlBlob = new Blob([data.html], { type: 'text/html' });
            setHtmlDownloadUrl(URL.createObjectURL(htmlBlob));
            setReconstructedHtml(data.html);
            setStatus('success');

        } catch (err: any) {
            console.error("Reconstruction Error:", err);
            setErrorMsg(err.message || "An unknown error occurred during HTML reconstruction.");
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

            <div className="flex justify-center mb-8">
                <div 
                    onClick={() => setUsePythonEngine(!usePythonEngine)}
                    className="flex items-center gap-4 bg-(--bg-glass) p-2 rounded-full border border-(--border-subtle) cursor-pointer"
                >
                    <div className={`px-4 py-2 rounded-full text-xs font-bold transition-all ${!usePythonEngine ? 'bg-indigo-500 text-white shadow-lg' : 'text-(--text-muted)'}`}>
                        STANDARD (Cloud)
                    </div>
                    <div className={`px-4 py-2 rounded-full text-xs font-bold transition-all ${usePythonEngine ? 'bg-emerald-500 text-white shadow-lg' : 'text-(--text-muted)'}`}>
                        HIGH-FIDELITY (Python Local)
                    </div>
                </div>
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
                                <div className="flex flex-col sm:flex-row gap-4 w-full justify-center">
                                    <button 
                                        onClick={handleConvert}
                                        className="btn-primary flex-1 px-8 py-4 text-sm font-bold tracking-widest uppercase flex items-center justify-center gap-2"
                                    >
                                        <FileText size={18} />
                                        Convert to Word Magic
                                    </button>
                                    
                                    <button 
                                        onClick={handleHtmlReconstruct}
                                        className="btn-secondary flex-1 px-8 py-4 text-sm font-bold tracking-widest uppercase flex items-center justify-center gap-2 border-indigo-500/30 hover:border-indigo-500 text-indigo-400"
                                    >
                                        <div className="w-5 h-5 rounded bg-indigo-500 flex items-center justify-center">
                                            <span className="text-[10px] text-white">HT</span>
                                        </div>
                                        Pixel-Perfect HTML
                                    </button>
                                </div>
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

                            {status === 'reconstructing-html' && (
                                <div className="flex flex-col items-center text-emerald-400">
                                    <div className="relative w-16 h-16 mb-4">
                                        <div className="absolute inset-0 border-4 border-emerald-500/20 rounded-full"></div>
                                        <div className="absolute inset-0 border-4 border-emerald-500 rounded-full border-t-transparent animate-spin"></div>
                                        <div className="absolute inset-0 m-auto w-6 h-6 flex items-center justify-center font-black text-xs">HTML</div>
                                    </div>
                                    <p className="font-bold tracking-wide text-center">AI UI/UX Specialist is reconstructing <br/>pixel-perfect HTML structure...</p>
                                    <p className="text-xs text-(--text-muted) mt-2">Extracting geometry, colors, and typography.</p>
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
                                    <h3 className="text-2xl font-black text-(--text-primary) mb-2">
                                        {reconstructedHtml ? "Reconstruction Complete!" : "Conversion Complete!"}
                                    </h3>
                                    <p className="text-(--text-secondary) mb-8 text-center">
                                        {reconstructedHtml 
                                            ? "Your document has been precisely reconstructed into high-fidelity HTML/CSS." 
                                            : "Your document has been successfully converted to Word format."}
                                    </p>
                                    
                                    <div className="flex flex-col sm:flex-row gap-4 w-full justify-center">
                                        {downloadUrl && (
                                            <a 
                                                href={downloadUrl} 
                                                download 
                                                className="btn-primary px-8 py-3 flex items-center justify-center gap-2"
                                            >
                                                <Download size={18} />
                                                Download .docx
                                            </a>
                                        )}
                                        
                                        {(usePythonEngine || reconstructedHtml) && htmlDownloadUrl && (
                                            <a 
                                                href={htmlDownloadUrl} 
                                                download={reconstructedHtml ? "reconstructed_doc.html" : "converted_ai.html"}
                                                className="btn-secondary px-8 py-3 flex items-center justify-center gap-2 border-emerald-500/30 hover:border-emerald-500/60 text-emerald-400"
                                            >
                                                <Download size={18} />
                                                Download HTML
                                            </a>
                                        )}

                                        <button 
                                            onClick={() => { setFile(null); setStatus('idle'); setHtmlDownloadUrl(''); setReconstructedHtml(''); setDownloadUrl(''); }}
                                            className="btn-secondary px-6 py-3"
                                        >
                                            Start New
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

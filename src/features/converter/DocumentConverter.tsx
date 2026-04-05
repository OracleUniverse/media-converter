import React, { useState, useRef } from 'react';
import { FileUp, FileText, Loader2, Download } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { splitPdfIntoImages } from '../../lib/pdf';

interface Artifact {
    id: string;
    type: string;
    description: string;
    bbox: [number, number, number, number];
    aspect_ratio: number;
}

interface DocumentConverterProps {
    userId: string;
    userRole?: string;
}

function wrapAiHtml(html: string): string {
    return `
    <div class="pdf-page-container" style="width: 100%; overflow-x: auto; padding: 20px 0; background: #f8fafc;">
        <style>
            .semantic-grid-page {
                font-family: 'Amiri', 'Traditional Arabic', 'Times New Roman', serif;
                line-height: 1.6;
                color: #1a1a1a;
            }
            .semantic-grid-page table[border="1"] {
                border: 1px solid #000;
                border-collapse: collapse;
                margin: 10px 0;
            }
            .semantic-grid-page table[border="1"] td {
                border: 1px solid #000;
                padding: 8px;
            }
            .semantic-grid-page [dir="rtl"] {
                text-align: right;
            }
        </style>
        <div class="pdf-page semantic-grid-page" style="width: 1024px; min-height: auto; background: white; margin: 0 auto; box-shadow: 0 10px 25px rgba(0,0,0,0.15); border-radius: 4px; padding: 40px; box-sizing: border-box; overflow: visible; position: relative;">
            ${html}
        </div>
    </div>`;
}

export const DocumentConverter: React.FC<DocumentConverterProps> = ({ userId: _userId }) => {
    const [file, setFile] = useState<File | null>(null);
    const [status, setStatus] = useState<'idle' | 'preparing' | 'processing' | 'reconstructing-html' | 'success' | 'error'>('idle');
    const [errorMsg, setErrorMsg] = useState<string>('');
    const [downloadUrl, setDownloadUrl] = useState<string>('');
    const [htmlDownloadUrl, setHtmlDownloadUrl] = useState<string>('');
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const selected = e.target.files?.[0];
        if (selected && selected.type === 'application/pdf') {
            setFile(selected);
            setDownloadUrl('');
            setHtmlDownloadUrl('');
            setStatus('idle');
            setErrorMsg('');
        }
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        const dropped = e.dataTransfer.files?.[0];
        if (dropped && dropped.type === 'application/pdf') {
            setFile(dropped);
            setDownloadUrl('');
            setHtmlDownloadUrl('');
            setStatus('idle');
            setErrorMsg('');
        }
    };

    const bakePortableHtml = async (rawHtml: string, artifacts: Artifact[], imageUrl: string) => {
        let bakedHtml = rawHtml;
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx || !artifacts || artifacts.length === 0) return bakedHtml;

        for (const artifact of artifacts) {
            const [ymin, xmin, ymax, xmax] = artifact.bbox;
            const width = xmax - xmin;
            const height = ymax - ymin;

            if (width <= 0 || height <= 0) continue;

            const img = new Image();
            img.crossOrigin = "anonymous";
            img.src = imageUrl;
            await new Promise(r => img.onload = r);

            canvas.width = width;
            canvas.height = height;
            ctx.drawImage(img, xmin, ymin, width, height, 0, 0, width, height);
            const base64Crop = canvas.toDataURL('image/jpeg', 0.85);

            const placeholderPattern = new RegExp(`<div[^>]+data-artifact-id="${artifact.id}"[^>]*>.*?</div>`, 'g');
            
            // PIXEL-PRECISE RENDERING: Use absolute pixel dimensions from the BBox
            bakedHtml = bakedHtml.replace(placeholderPattern, `<img src="${base64Crop}" style="width:${width}px; height:${height}px; display:block; border-radius:4px;" alt="${artifact.description}" />`);
        }
        return bakedHtml;
    };

    const handleConvert = async () => {
        if (!file) return;
        try {
            setStatus('preparing');
            setErrorMsg('');
            const formData = new FormData();
            formData.append('file', file);
            const { data, error } = await supabase.functions.invoke('convert-pdf-word', { body: formData });
            if (error || !data?.success) throw new Error(error?.message || data?.error || 'Conversion failed');
            const { data: urlData, error: urlError } = await supabase.storage.from('conv_files').createSignedUrl(data.filePath, 3600);
            if (urlError) throw urlError;
            setDownloadUrl(urlData.signedUrl);
            setStatus('success');
        } catch (err: any) {
            setErrorMsg(err.message || "Unknown error");
            setStatus('error');
        }
    };

    const handleHtmlReconstruct = async () => {
        if (!file) return;
        try {
            setStatus('preparing');
            const imageFiles = await splitPdfIntoImages(file, 1.0, 1.0, true);
            const base64Images = await Promise.all(imageFiles.map(async (img) => {
                const buffer = await img.arrayBuffer();
                const base64 = btoa(new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), ''));
                return { mimeType: img.type, data: base64, url: URL.createObjectURL(img) };
            }));
            
            setStatus('reconstructing-html');
            const { data: { session } } = await supabase.auth.getSession();
            let finalHtml = '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8" />\n<style>body { font-family: sans-serif; background-color: #e5e7eb; padding: 20px; } .semantic-grid-page table { table-layout: fixed; width: 100%; border-collapse: collapse; } .semantic-grid-page td { border: 0px solid #eee; vertical-align: top; padding: 4px; overflow: visible; font-size: 14px; }</style>\n</head>\n<body>\n';

            for (let i = 0; i < base64Images.length; i++) {
                const imgObj = new Image();
                imgObj.src = base64Images[i].url;
                await new Promise(r => imgObj.onload = r);
                const dims = { width: imgObj.width, height: imgObj.height };
                
                const { data, error } = await supabase.functions.invoke('reconstruct-pdf-html', {
                    headers: { Authorization: `Bearer ${session?.access_token}` },
                    body: { images: [{ mimeType: base64Images[i].mimeType, data: base64Images[i].data }], model: 'google/gemini-2.0-flash-001', dimensions: dims }
                });
                
                if (error || !data?.success) throw new Error(error?.message || data?.error || 'Reconstruction failed');
                
                if (data.html) {
                    // BAKE THIS PAGE IMMEDIATELY to avoid ID collisions across pages
                    const bakedPageHtml = await bakePortableHtml(wrapAiHtml(data.html), data.artifacts || [], base64Images[i].url);
                    finalHtml += bakedPageHtml;
                }
            }
            finalHtml += '\n</body>\n</html>';
            const htmlBlob = new Blob([finalHtml], { type: 'text/html' });
            setHtmlDownloadUrl(URL.createObjectURL(htmlBlob));
            setStatus('success');
        } catch (err: any) {
            setErrorMsg(err.message || "Unknown error");
            setStatus('error');
        }
    };

    return (
        <div className="max-w-4xl mx-auto py-12">
            <div className="text-center mb-10">
                <h1 className="text-4xl font-black tracking-tight gradient-text mb-4">AI PDF to Word Converter</h1>
                <p className="text-(--text-secondary) max-w-2xl mx-auto">Transform PDFs into high-fidelity documents.</p>
            </div>
            <div className="bg-(--card-bg) border border-(--border-subtle) rounded-3xl p-8 shadow-xl">
                {!file ? (
                    <div 
                        onDragOver={(e) => e.preventDefault()} onDrop={handleDrop} onClick={() => fileInputRef.current?.click()}
                        className="border-2 border-dashed border-(--border-subtle) hover:border-indigo-500/50 rounded-2xl p-16 flex flex-col items-center justify-center cursor-pointer transition-all bg-(--bg-glass)"
                    >
                        <FileUp size={28} className="text-indigo-400 mb-6" />
                        <h3 className="text-lg font-bold text-(--text-primary)">Upload a PDF</h3>
                        <input type="file" accept=".pdf" className="hidden" ref={fileInputRef} onChange={handleFileSelect} />
                    </div>
                ) : (
                    <div className="space-y-8">
                        <div className="flex items-center p-4 bg-(--bg-glass) border border-(--border-subtle) rounded-xl">
                            <FileText size={24} className="text-red-400" />
                            <h4 className="ml-4 font-bold text-(--text-primary) truncate">{file.name}</h4>
                        </div>
                        <div className="flex flex-col sm:flex-row gap-4 w-full justify-center">
                            <button onClick={handleConvert} className="btn-primary flex-1 px-8 py-4">Word Magic</button>
                            <button onClick={handleHtmlReconstruct} className="btn-secondary flex-1 px-8 py-4 text-xs tracking-widest uppercase">Forensic HTML Grid</button>
                        </div>
                    </div>
                )}
            </div>
            {status === 'reconstructing-html' && (
                <div className="mt-12 flex flex-col items-center text-indigo-400">
                    <Loader2 size={32} className="animate-spin mb-4" />
                    <p className="text-lg font-bold">Baking Portable Forensic Grid...</p>
                </div>
            )}
            {status === 'error' && <div className="mt-8 p-4 bg-red-500/10 border border-red-500/20 rounded-xl text-red-500 text-center font-bold">{errorMsg}</div>}
            {status === 'success' && (
                <div className="mt-12 flex flex-col sm:flex-row gap-4 justify-center animate-in fade-in zoom-in">
                    {downloadUrl && <a href={downloadUrl} download className="btn-primary px-12 py-4 flex items-center gap-3"><Download size={20} /> Word</a>}
                    {htmlDownloadUrl && <a href={htmlDownloadUrl} download="forensic_reconstruction.html" className="btn-secondary px-12 py-4 flex items-center gap-3 border-emerald-500/30 text-emerald-400"><Download size={20} /> HTML</a>}
                    <button onClick={() => { setFile(null); setStatus('idle'); setHtmlDownloadUrl(''); }} className="btn-secondary px-8 py-4 opacity-60">New File</button>
                </div>
            )}
        </div>
    );
};

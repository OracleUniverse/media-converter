import React, { useState, useRef } from 'react';
import { FileUp, FileText, Loader2, Download, Zap } from 'lucide-react';
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
            .semantic-grid-page img {
                max-width: 100%;
                object-fit: contain;
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
    const [simpleHtmlUrl, setSimpleHtmlUrl] = useState<string>('');
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const selected = e.target.files?.[0];
        if (selected && selected.type === 'application/pdf') {
            setFile(selected);
            setDownloadUrl('');
            setHtmlDownloadUrl('');
            setSimpleHtmlUrl('');
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
            setSimpleHtmlUrl('');
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

            // FIND placeholder and REPLACE in-place
            const placeholderPattern = new RegExp(`<div[^>]+data-artifact-id="${artifact.id}"[^>]*>.*?</div>`, 'g');
            
            // IN-GRID RENDERING: Restore artifacts to their respectful locations
            bakedHtml = bakedHtml.replace(placeholderPattern, 
                `<img src="${base64Crop}" style="width:100%; height:100%; display:block; object-fit:none;" alt="${artifact.description}" />`
            );
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
            // console.log(`📄 PDF Split complete: ${imageFiles.length} pages generated.`);
            
            const base64Images = await Promise.all(imageFiles.map(async (img) => {
                const buffer = await img.arrayBuffer();
                const base64 = btoa(new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), ''));
                // console.log(`🖼️ Page ${idx + 1} ready for transmission.`);
                return { mimeType: img.type, data: base64, url: URL.createObjectURL(img) };
            }));
            
            setStatus('reconstructing-html');
            const { data: { session } } = await supabase.auth.getSession();
            let finalHtmlContent = '';

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
                
                /*
                console.log(`📊 AI Usage for Page ${i + 1}:`, {
                    inputTokens: data.usage?.prompt_tokens,
                    outputTokens: data.usage?.completion_tokens,
                    totalTokens: data.usage?.total_tokens,
                    resolution: data.resolution
                });
                */

                if (data.html) {
                    const bakedPageHtml = await bakePortableHtml(wrapAiHtml(data.html), data.artifacts || [], base64Images[i].url);
                    finalHtmlContent += bakedPageHtml;
                }
            }
            const finalHtml = `<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8" />\n<style>body { font-family: sans-serif; background-color: #e5e7eb; padding: 20px; } .page { page-break-after: always; }</style>\n</head>\n<body>\n${finalHtmlContent}\n</body>\n</html>`;
            // console.log(`✅ Reconstruction Complete! Total size: ${finalHtml.length} characters.`);
            const htmlBlob = new Blob([finalHtml], { type: 'text/html' });
            setHtmlDownloadUrl(URL.createObjectURL(htmlBlob));
            setStatus('success');
        } catch (err: any) {
            setErrorMsg(err.message || "Unknown error");
            setStatus('error');
        }
    };

    const handleSimpleClone = async () => {
        if (!file) return;
        try {
            setStatus('preparing');
            setErrorMsg('');
            const imageFiles = await splitPdfIntoImages(file, 1.0, 1.0, true);
            // console.log(`📄 PDF Split complete: ${imageFiles.length} pages generated.`);
            
            const base64Images = await Promise.all(imageFiles.map(async (img) => {
                const buffer = await img.arrayBuffer();
                const base64 = btoa(new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), ''));
                // console.log(`🖼️ Page ${idx + 1} ready for transmission.`);
                return { mimeType: img.type, data: base64 };
            }));

            setStatus('reconstructing-html');
            const { data: { session } } = await supabase.auth.getSession();
            let aggregatedHtml = '';

            for (let i = 0; i < base64Images.length; i++) {
                const imgData = base64Images[i];
                const imgObj = new Image();
                imgObj.src = `data:${imgData.mimeType};base64,${imgData.data}`;
                await new Promise(r => imgObj.onload = r);
                const dims = { width: imgObj.width, height: imgObj.height };

                // console.log(`🚀 Sending Page ${i + 1} to AI (Simple Clone Mode)...`);
                
                const { data, error } = await supabase.functions.invoke('reconstruct-pdf-html', {
                    headers: { Authorization: `Bearer ${session?.access_token}` },
                    body: { 
                        images: [imgData], 
                        model: 'google/gemini-2.0-flash-001', 
                        dimensions: dims
                    }
                });

                if (error || !data?.success) throw new Error(error?.message || data?.error || 'Simple Clone failed');
                
                /*
                console.log(`📊 AI Usage for Page ${i + 1} (Clone):`, {
                    inputTokens: data.usage?.prompt_tokens,
                    outputTokens: data.usage?.completion_tokens,
                    totalTokens: data.usage?.total_tokens,
                    htmlLength: data.html?.length || 0
                });
                */

                if (data.html) {
                    // console.log(`📜 RAW AI SOURCE CODE (Page ${i + 1}):\n`, data.html);
                    aggregatedHtml += data.html;
                    
                    // Force a Word-compatible Page Break after each page (except potentially the last)
                    if (i < base64Images.length - 1) {
                        aggregatedHtml += `<br style="page-break-before: always; clear: both; mso-break-type: section-break;" />`;
                    }
                }
            }

            const masterExportScript = `
<script>
function exportToWord() {
  var header = "<html xmlns:o='urn:schemas-microsoft-com:office:office' "+
        "xmlns:w='urn:schemas-microsoft-com:office:word' "+
        "xmlns='http://www.w3.org/TR/REC-html40'>"+
        "<head><meta charset='utf-8'><title>Export HTML to Word</title></head><body>";
  var footer = "</body></html>";
  var sourceHTML = header + document.getElementById("content-to-export").innerHTML + footer;
  
  var source = 'data:application/vnd.ms-word;charset=utf-8,' + encodeURIComponent(sourceHTML);
  var fileDownload = document.createElement("a");
  document.body.appendChild(fileDownload);
  fileDownload.href = source;
  fileDownload.download = 'document.doc';
  fileDownload.click();
  document.body.removeChild(fileDownload);
}
</script>
            `;

            const finalHtml = `<!DOCTYPE html><html><head>${masterExportScript}</head><body style="margin:0;padding:20px;background:#f0f2f5;">
                <button onclick="exportToWord()" style="position:fixed;top:10px;right:10px;z-index:9999;padding:12px 24px;background:#007bff;color:white;border:none;border-radius:6px;cursor:pointer;font-weight:bold;box-shadow:0 2px 8px rgba(0,0,0,0.2);">Export Full Document to Word</button>
                <div id="content-to-export">
                    ${aggregatedHtml}
                </div>
            </body></html>`;
            // console.log(`✅ Simple Clone Complete! Total aggregated HTML size: ${finalHtml.length} characters.`);
            const blob = new Blob([finalHtml], { type: 'text/html' });
            setSimpleHtmlUrl(URL.createObjectURL(blob));
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
                            <button onClick={handleHtmlReconstruct} className="btn-secondary flex-1 px-8 py-4 text-[10px] tracking-widest uppercase">Forensic Grid</button>
                            <button onClick={handleSimpleClone} className="btn-secondary flex-1 px-8 py-4 text-[10px] tracking-widest uppercase border-amber-500/30 text-amber-500 flex items-center justify-center gap-2">
                                <Zap size={14} /> Simple Clone
                            </button>
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
                    {simpleHtmlUrl && <a href={simpleHtmlUrl} download="ai_simple_clone.html" className="btn-secondary px-12 py-4 flex items-center gap-3 border-amber-500/30 text-amber-500"><Download size={20} /> Clone</a>}
                    <button onClick={() => { setFile(null); setStatus('idle'); setHtmlDownloadUrl(''); setSimpleHtmlUrl(''); }} className="btn-secondary px-8 py-4 opacity-60">New File</button>
                </div>
            )}
        </div>
    );
};

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
    const [gpt4HtmlUrl, setGpt4HtmlUrl] = useState<string>('');
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const selected = e.target.files?.[0];
        if (selected && selected.type === 'application/pdf') {
            setFile(selected);
            setDownloadUrl('');
            setHtmlDownloadUrl('');
            setSimpleHtmlUrl('');
            setGpt4HtmlUrl('');
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
            setGpt4HtmlUrl('');
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
            
            // FIND placeholder and REPLACE in-place
            // Use [\s\S]*? to match across multiple lines (dotAll)
            const placeholderPattern = new RegExp(`<(div|table)[^>]+data-artifact-id="${artifact.id}"[^>]*>[\\s\\S]*?</(div|table)>`, 'i');
            
            // Forensic coordinate rounding
            const ryMin = Math.floor(ymin);
            const rxMin = Math.floor(xmin);
            const ryMax = Math.ceil(ymax);
            const rxMax = Math.ceil(xmax);
            const rWidth = rxMax - rxMin;
            const rHeight = ryMax - ryMin;

            if (rWidth <= 0 || rHeight <= 0) continue;

            // Load and Slice
            const img = new Image();
            img.crossOrigin = "anonymous";
            img.src = imageUrl;
            await new Promise(r => img.onload = r);

            canvas.width = rWidth;
            canvas.height = rHeight;
            ctx.drawImage(img, rxMin, ryMin, rWidth, rHeight, 0, 0, rWidth, rHeight);
            const base64Crop = canvas.toDataURL('image/jpeg', 0.75);
            
            bakedHtml = bakedHtml.replace(placeholderPattern, 
                `<img src="${base64Crop}" width="${rWidth}" height="${rHeight}" style="width:100%; max-width:${rWidth}px; height:auto; display:block; border:none; mso-height-rule:exactly;" alt="${artifact.description}" />`
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

    const reconstructWithModel = async (model: string, setter: (url: string) => void) => {
        if (!file) return;
        try {
            console.log(`🚀 Starting Reconstruction [${model}] for file: ${file.name}`);
            setStatus('preparing');
            setErrorMsg('');
            
            const imageFiles = await splitPdfIntoImages(file, 1.0, 1.0, true);
            console.log(`📄 PDF Split complete: ${imageFiles.length} pages generated.`);
            
            const base64Images = await Promise.all(imageFiles.map(async (img, idx) => {
                const buffer = await img.arrayBuffer();
                const base64 = btoa(new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), ''));
                console.log(`🖼️ Page ${idx + 1} encoded (Size: ${Math.round(base64.length / 1024)} KB)`);
                return { mimeType: img.type, data: base64, url: URL.createObjectURL(img) };
            }));

            setStatus('reconstructing-html');
            const { data: { session } } = await supabase.auth.getSession();
            let aggregatedHtml = '';

            for (let i = 0; i < base64Images.length; i++) {
                const imgData = base64Images[i];
                const imgObj = new Image();
                imgObj.src = imgData.url;
                await new Promise(r => imgObj.onload = r);
                const dims = { width: imgObj.width, height: imgObj.height };

                console.log(`📡 Calling Supabase Edge Function [${model}] for Page ${i + 1}...`);
                const { data, error } = await supabase.functions.invoke('reconstruct-pdf-html', {
                    headers: { Authorization: `Bearer ${session?.access_token}` },
                    body: { 
                        images: [{ mimeType: imgData.mimeType, data: imgData.data }], 
                        model: model, 
                        dimensions: dims
                    }
                });

                if (error || !data?.success) {
                    console.error(`❌ AI Error on Page ${i + 1}:`, error || data?.error);
                    console.log("Full Error Object:", data);
                    throw new Error(error?.message || data?.error || 'Reconstruction failed');
                }
                
                console.log(`📊 AI Result Page ${i + 1}:`, {
                    artifactsCount: data.artifacts?.length || 0,
                    htmlLength: data.html?.length || 0,
                    usage: data.usage,
                    fullResponse: data
                });

                if (data.html && data.html.includes('REPAIR FAILED')) {
                    console.warn(`⚠️ Warning: Forensic Repair failed for Page ${i + 1}. The AI response might be malformed.`);
                    if (data.rawAiOutput) {
                        console.log(`📜 Raw AI Output (Page ${i + 1}):\n`, data.rawAiOutput);
                    }
                    if (data.finishReason) {
                        console.log(`🏁 Finish Reason (Page ${i + 1}):`, data.finishReason);
                    }
                }

                if (data.html) {
                    const bakedPageHtml = await bakePortableHtml(data.html, data.artifacts || [], imgData.url);
                    aggregatedHtml += bakedPageHtml;
                    
                    if (i < base64Images.length - 1) {
                        aggregatedHtml += `<br style="page-break-before: always; clear: both; mso-break-type: section-break;" />`;
                    }
                }
            }

            const isGpt4 = model.includes('gpt-4');
            const title = isGpt4 ? 'GPT-4 Vision Export' : 'Forensic Export';
            const btnColor = isGpt4 ? '#10a37f' : '#007bff';

            const masterExportScript = `
<script>
function exportToWord() {
  try {
    const content = document.getElementById('content-to-export');
    const images = content.getElementsByTagName('img');
    const boundary = '----=_NextPart_000_01D4_01D4A5C1.12345678';
    const wrap = (s) => s.replace(/(.{76})/g, '$1\\r\\n');
    let mhtml = 'MIME-Version: 1.0\\r\\n';
    mhtml += 'Content-Type: multipart/related; boundary="' + boundary + '"\\r\\n\\r\\n';
    const imageMap = new Map();
    const imageParts = [];
    let tempHtml = content.innerHTML;
    for (let i = 0; i < images.length; i++) {
        const img = images[i];
        const src = img.getAttribute('src');
        if (src && src.startsWith('data:image')) {
            if (!imageMap.has(src)) {
                const cid = 'image' + imageMap.size + '@forensic.media';
                const parts = src.split(',');
                const mimeType = parts[0].split(':')[1].split(';')[0];
                const base64Data = parts[1];
                imageMap.set(src, cid);
                let part = '--' + boundary + '\\r\\n';
                part += 'Content-Type: ' + mimeType + '\\r\\n';
                part += 'Content-Transfer-Encoding: base64\\r\\n';
                part += 'Content-ID: <' + cid + '>\\r\\n';
                part += 'Content-Location: ' + cid + '\\r\\n\\r\\n';
                part += wrap(base64Data) + '\\r\\n';
                imageParts.push(part);
            }
        }
    }
    imageMap.forEach((cid, src) => {
        tempHtml = tempHtml.split(src).join('cid:' + cid);
    });
    let htmlBody = '<html xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">';
    htmlBody += '<head><meta charset="utf-8"><title>${title}</title>';
    htmlBody += '<style>td, tr { mso-line-height-rule: at-least; line-height: normal; }</style>';
    htmlBody += '</head><body>' + tempHtml + '</body></html>';
    const base64Html = btoa(unescape(encodeURIComponent(htmlBody)));
    mhtml += '--' + boundary + '\\r\\n';
    mhtml += 'Content-Type: text/html; charset="utf-8"\\r\\n';
    mhtml += 'Content-Transfer-Encoding: base64\\r\\n\\r\\n';
    mhtml += wrap(base64Html) + '\\r\\n\\r\\n';
    for (let i = 0; i < imageParts.length; i++) {
        mhtml += imageParts[i];
    }
    mhtml += '--' + boundary + '--\\r\\n';
    const blob = new Blob([mhtml], { type: 'application/msword' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = '${isGpt4 ? 'gpt4_vision_clone.doc' : 'simple_clone.doc'}';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    alert('Export Error: ' + err.message);
  }
}
</script>
            `;

            const finalHtml = `<!DOCTYPE html><html><head>${masterExportScript}</head><body style="margin:0;padding:20px;background:#f0f2f5;">
                <button onclick="exportToWord()" style="position:fixed;top:10px;right:10px;z-index:9999;padding:12px 24px;background:${btnColor};color:white;border:none;border-radius:6px;cursor:pointer;font-weight:bold;box-shadow:0 2px 8px rgba(0,0,0,0.2);">Export Full Document to Word</button>
                <div id="content-to-export">
                    ${aggregatedHtml}
                </div>
            </body></html>`;
            
            console.log(`✅ Reconstruction Complete for ${model}!`);
            const blob = new Blob([finalHtml], { type: 'text/html' });
            setter(URL.createObjectURL(blob));
            setStatus('success');
        } catch (err: any) {
            console.error(`💥 Fatal Error in ${model}:`, err);
            setErrorMsg(err.message || "Unknown error");
            setStatus('error');
        }
    };

    const handleSimpleClone = () => reconstructWithModel('openai/gpt-5.4', setSimpleHtmlUrl);
    const handleGpt4Vision = () => reconstructWithModel('openai/gpt-5.4', setGpt4HtmlUrl);

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
                            <button onClick={handleGpt4Vision} className="btn-secondary flex-1 px-8 py-4 text-[10px] tracking-widest uppercase border-emerald-500/30 text-emerald-500 flex items-center justify-center gap-2 focus:ring-emerald-500/50">
                                <Zap size={14} /> GPT-4 Vision
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
                    {gpt4HtmlUrl && <a href={gpt4HtmlUrl} download="gpt4_vision_clone.html" className="btn-secondary px-12 py-4 flex items-center gap-3 border-emerald-500/30 text-emerald-400"><Download size={20} /> GPT-4 V</a>}
                    <button onClick={() => { setFile(null); setStatus('idle'); setHtmlDownloadUrl(''); setSimpleHtmlUrl(''); setGpt4HtmlUrl(''); }} className="btn-secondary px-8 py-4 opacity-60">New File</button>
                </div>
            )}
        </div>
    );
};

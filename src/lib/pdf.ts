import * as pdfjsLib from 'pdfjs-dist';

import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';

if (pdfjsLib?.GlobalWorkerOptions) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;
}

/**
 * PDF PROCESSING PIPELINE (pdf.ts)
 * -------------------------------
 * This utility decomposes multi-page PDFs into individual image snapshots.
 * This is a prerequisite for our "Two-Pass" AI extraction strategy,
 * as Gemini (and most Vision LLMs) process images more reliably than raw PDF bytes.
 */

export async function splitPdfIntoImages(file: File, scale = 0.75, quality = 0.6, useColor = false): Promise<File[]> {
    if (file.type !== 'application/pdf') {
        return [file];
    }
    
    try {
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        const numPages = pdf.numPages;
        const images: File[] = [];

        for (let i = 1; i <= numPages; i++) {
            const page = await pdf.getPage(i);
            
            /**
             * DIMENSIONAL OPTIMIZATION
             * We cap the maximum dimension at 1024px.
             * This balances visual clarity for OCR with low token costs/latency.
             */
            let viewport = page.getViewport({ scale: 1.0 });
            const fitScale = Math.min(1024 / viewport.width, 1024 / viewport.height, scale);
            viewport = page.getViewport({ scale: fitScale });
            
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            
            if (!context) continue;

            canvas.height = viewport.height;
            canvas.width = viewport.width;

            /**
             * GRAYSCALE FILTERING
             * Converting to grayscale reduces the entropy of the image.
             * This results in smaller JPEG/PNG file sizes and often helps the AI
             * focus on text contrast rather than color variations.
             * 
             * For HTML Reconstruction, we bypass this to extract colors.
             */
            if (!useColor) {
                context.filter = 'grayscale(100%)';
            }

            await page.render({
                canvasContext: context,
                viewport: viewport,
                canvas
            }).promise;

            const blob = await new Promise<Blob | null>(resolve => 
                canvas.toBlob(resolve, 'image/jpeg', quality) 
            );
            
            if (blob) {
                // name it intuitively
                const safeName = file.name.replace(/\.pdf$/i, '');
                images.push(new File([blob], `${safeName}_page_${i}.jpg`, { type: 'image/jpeg' }));
            }
        }
        return images;
    } catch (error) {
        console.error("Failed to split PDF:", error);
        throw new Error("Unable to process this PDF safely in your browser. Please upgrade to a modern browser (Chrome, Edge, or Firefox) or try a smaller file.");
    }
}

/**
 * Renders a specific page from a PDF File to a high-quality image File
 */
export async function renderPageToImage(file: File, pageNum: number, scale = 1.5, quality = 0.9): Promise<File | null> {
    try {
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        const page = await pdf.getPage(pageNum);
        
        // Calculate scale to ensure max dimension is 1024px
        let viewport = page.getViewport({ scale: 1.0 });
        const fitScale = Math.min(1024 / viewport.width, 1024 / viewport.height, scale);
        viewport = page.getViewport({ scale: fitScale });
        
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        if (!context) return null;

        canvas.height = viewport.height;
        canvas.width = viewport.width;
        context.filter = 'grayscale(100%)';

        await page.render({
            canvasContext: context,
            viewport: viewport,
            canvas
        }).promise;

        const blob = await new Promise<Blob | null>(resolve => 
            canvas.toBlob(resolve, quality > 0.8 ? 'image/png' : 'image/jpeg', quality)
        );

        if (blob) {
            const safeName = file.name.replace(/\.pdf$/i, '');
            const ext = quality > 0.8 ? 'png' : 'jpg';
            const type = quality > 0.8 ? 'image/png' : 'image/jpeg';
            return new File([blob], `${safeName}_p${pageNum}_highres.${ext}`, { type });
        }
        return null;
    } catch (error) {
        console.error("Failed to render high-res page:", error);
        throw new Error(`Failed to render Page ${pageNum} for extraction. Please ensure the file is not corrupted and your browser is up to date.`);
    }
}
/**
 * SPATIAL METADATA EXTRACTION
 * This function extracts the coordinates, font info, and raw text of every element.
 * It serves as a "Structural Blueprint" for the AI during reconstruction.
 */
export async function extractSpatialMetadata(file: File) {
    try {
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        const numPages = pdf.numPages;
        const metadata = [];

        for (let i = 1; i <= numPages; i++) {
            const page = await pdf.getPage(i);
            const textContent = await page.getTextContent();
            const viewport = page.getViewport({ scale: 1.0 });

            const items = textContent.items.map((item: any) => {
                // transform: [scaleX, skewY, skewX, scaleY, x, y]
                // We normalize coordinates to the viewport
                const tx = item.transform;
                const x = tx[4];
                const y = viewport.height - tx[5]; // Flip Y for standard coordinates

                return {
                    text: item.str,
                    x: Math.round(x),
                    y: Math.round(y),
                    width: Math.round(item.width),
                    height: Math.round(item.height),
                    font: item.fontName,
                    dir: item.dir, // Direction (rtl/ltr)
                    hasWhitespace: item.hasWhitespace
                };
            });

            metadata.push({
                pageIndex: i,
                width: viewport.width,
                height: viewport.height,
                elements: items
            });
        }
        return metadata;
    } catch (error) {
        console.error("Failed to extract spatial metadata:", error);
        return [];
    }
}

/**
 * IMAGE OPTIMIZATION (imageOptimization.ts)
 * ---------------------------------------
 * This utility ensures that images uploaded to the platform are 
 * "AI-ready" by performing client-side resizing and compression.
 * 
 * Benefits:
 * 1. Reduced Bandwidth: Uploads 2-5MB photos as ~150KB JPEGs.
 * 2. Faster AI Inference: Vision models process smaller images significantly faster.
 * 3. Token Savings: Smaller images consume fewer tokens in many model-pricing tiers.
 */
export async function shrinkImage(file: File, maxDimension: number = 1024, quality: number = 0.5): Promise<File> {
    // If it's not an image, return original
    if (!file.type.startsWith('image/')) {
        return file;
    }

    // PDFs are already handled by splitPdfIntoImages which converts pages to images
    if (file.type === 'application/pdf') {
        return file;
    }

    try {
        const url = URL.createObjectURL(file);
        const img = new Image();
        
        await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
            img.src = url;
        });

        const originalWidth = img.width;
        const originalHeight = img.height;

        /**
         * ASPECT RATIO PRESERVATION
         * We maintain the original proportions while scaling down to 
         * the 'maxDimension' boundary.
         */
        let targetWidth = originalWidth;
        let targetHeight = originalHeight;

        // Shrink if needed
        if (originalWidth > maxDimension || originalHeight > maxDimension) {
            if (originalWidth > originalHeight) {
                targetWidth = maxDimension;
                targetHeight = Math.round((originalHeight * maxDimension) / originalWidth);
            } else {
                targetHeight = maxDimension;
                targetWidth = Math.round((originalWidth * maxDimension) / originalHeight);
            }
        }

        const canvas = document.createElement('canvas');
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            URL.revokeObjectURL(url);
            return file;
        }

        /**
         * PAYLOAD ENTROPY REDUCTION
         * Filtering to grayscale before generating the blob 
         * drastically reduces JPEG file size without losing OCR-critical data.
         */
        ctx.filter = 'grayscale(100%)';
        
        ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
        
        const blob = await new Promise<Blob | null>(resolve => 
            canvas.toBlob(resolve, 'image/jpeg', quality)
        );

        URL.revokeObjectURL(url);

        if (!blob) throw new Error("Failed to process image content.");

        const newName = file.name.replace(/\.[^/.]+$/, "") + ".jpg";
        return new File([blob], newName, { type: 'image/jpeg' });
    } catch (e) {
        console.error("Image shrinking failed:", e);
        throw new Error("Unable to process this image safely. Please ensure the file is not corrupted.");
    }
}

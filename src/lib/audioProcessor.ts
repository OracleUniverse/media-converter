import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

const CHUNK_DURATION = 600; // 10 minutes in seconds

export interface AudioChunk {
    blob: Blob;
    index: number;
    total: number;
    startTime: number;
    endTime: number;
}

class AudioProcessor {
    private ffmpeg: FFmpeg | null = null;
    private loadingPromise: Promise<void> | null = null;

    async load() {
        if (this.ffmpeg) return;
        if (this.loadingPromise) return this.loadingPromise;

        this.loadingPromise = (async () => {
            this.ffmpeg = new FFmpeg();
            // Using a specific version to ensure compatibility
            const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
            await this.ffmpeg.load({
                coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
                wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
            });
        })();

        return this.loadingPromise;
    }

    /**
     * Extracts audio from a video/audio file and converts it to a compressed mono MP3.
     */
    async processMedia(file: File): Promise<Blob> {
        await this.load();
        const ffmpeg = this.ffmpeg!;
        
        // Use a safe filename for FFmpeg
        const extension = file.name.split('.').pop() || 'media';
        const inputName = `input.${extension}`;
        const outputName = 'output.mp3';

        await ffmpeg.writeFile(inputName, await fetchFile(file));
        
        // Command explanation:
        // -vn: disable video
        // -ac 1: set audio channels to 1 (mono)
        // -b:a 64k: set audio bitrate to 64kbps (excellent for speech, very small size)
        // -ar 16000: set sample rate to 16kHz (standard for many AI speech models)
        await ffmpeg.exec(['-i', inputName, '-vn', '-ac', '1', '-b:a', '64k', '-ar', '16000', outputName]);
        
        const data = await ffmpeg.readFile(outputName);
        
        // Cleanup input file to save memory in WASM
        await ffmpeg.deleteFile(inputName);
        await ffmpeg.deleteFile(outputName);

        return new Blob([data], { type: 'audio/mpeg' });
    }

    /**
     * Gets the duration of an audio blob using a hidden Audio element.
     */
    async getDuration(blob: Blob): Promise<number> {
        return new Promise((resolve, reject) => {
            const audio = new Audio();
            audio.src = URL.createObjectURL(blob);
            audio.onloadedmetadata = () => {
                const duration = audio.duration;
                URL.revokeObjectURL(audio.src);
                resolve(duration);
            };
            audio.onerror = (_e) => {
                URL.revokeObjectURL(audio.src);
                reject(new Error("Failed to load audio for duration check"));
            };
        });
    }

    /**
     * Slices an audio blob into chunks of CHUNK_DURATION.
     */
    async sliceAudio(file: Blob, duration: number): Promise<AudioChunk[]> {
        if (duration <= CHUNK_DURATION) {
            return [{
                blob: file,
                index: 0,
                total: 1,
                startTime: 0,
                endTime: duration
            }];
        }

        await this.load();
        const ffmpeg = this.ffmpeg!;
        const inputName = 'audio_to_slice.mp3';
        await ffmpeg.writeFile(inputName, await fetchFile(file));

        const chunks: AudioChunk[] = [];
        const totalChunks = Math.ceil(duration / CHUNK_DURATION);

        for (let i = 0; i < totalChunks; i++) {
            const start = i * CHUNK_DURATION;
            const outputName = `chunk_${i}.mp3`;
            
            // Slice the audio
            // -ss: start time
            // -t: duration
            // -c copy: use the same codec (fastest)
            await ffmpeg.exec([
                '-i', inputName,
                '-ss', start.toString(),
                '-t', CHUNK_DURATION.toString(),
                '-c', 'copy',
                outputName
            ]);

            const data = await ffmpeg.readFile(outputName);
            chunks.push({
                blob: new Blob([data], { type: 'audio/mpeg' }),
                index: i,
                total: totalChunks,
                startTime: start,
                endTime: Math.min(start + CHUNK_DURATION, duration)
            });
            
            await ffmpeg.deleteFile(outputName);
        }

        await ffmpeg.deleteFile(inputName);
        return chunks;
    }
}

export const audioProcessor = new AudioProcessor();

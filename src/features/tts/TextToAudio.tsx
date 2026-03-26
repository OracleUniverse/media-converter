import React, { useState } from 'react';
import { supabase } from '../../lib/supabase';
import { PlayCircle, Loader2, Volume2, Type } from 'lucide-react';

interface TextToAudioProps {
    userId: string;
}

const VOICES = [
    { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel (Female, Calm)' },
    { id: 'AZnzlk1XvdvUeBnXmlld', name: 'Domi (Female, Energetic)' },
    { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella (Female, Soft/Sweet)' },
    { id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam (Male, Deep/Authoritative)' },
    { id: 'ErXwobaYiN019PkySvjV', name: 'Antoni (Male, Well-rounded)' },
];

export const TextToAudio = ({ userId: _userId }: TextToAudioProps) => {
    const [text, setText] = useState('');
    const [title, setTitle] = useState('');
    const [voice, setVoice] = useState(VOICES[0].id);
    const [status, setStatus] = useState<'idle' | 'generating' | 'success' | 'error'>('idle');
    const [errorMsg, setErrorMsg] = useState('');
    const [resultUrl, setResultUrl] = useState<string | null>(null);

    const handleGenerate = async () => {
        if (!text.trim()) {
            setErrorMsg("Please enter some text to generate audio.");
            setStatus('error');
            return;
        }

        setStatus('generating');
        setErrorMsg('');
        setResultUrl(null);

        try {
            const selectedVoice = VOICES.find(v => v.id === voice);
            const { data, error } = await supabase.functions.invoke('generate-audio', {
                body: { 
                    text, 
                    voiceId: voice, 
                    voiceName: selectedVoice?.name.split(' ')[0] || voice,
                    title: title.trim() || undefined 
                }
            });

            if (error) {
                console.error("[TTS] Edge Function Error:", error);
                throw new Error("Failed to communicate with generator: " + error.message);
            }

            if (!data.success) {
                console.error("[TTS] Generation Error:", data);
                throw new Error(data.error || "Generation failed.");
            }

            // Success! Get the public URL for the generated file
            console.log("[TTS] Success metadata:", data.record);
            
            const { data: urlData } = supabase.storage
                .from('tts_audio_assets')
                .getPublicUrl(data.record.storage_path);
                
            setResultUrl(urlData.publicUrl);
            setStatus('success');
            
            // Clear inputs after 5 secs if successful
            setTimeout(() => {
                setStatus('idle');
                setText('');
                setTitle('');
            }, 10000);

        } catch (err: any) {
            console.error("[TTS] Error:", err);
            setErrorMsg(err.message || "An unknown error occurred.");
            setStatus('error');
        }
    };

    return (
        <div className="w-full max-w-4xl mx-auto p-4 sm:p-6 lg:p-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="mb-8">
                <h1 className="text-3xl font-black bg-clip-text text-transparent bg-linear-to-r from-blue-400 via-indigo-400 to-purple-400 inline-block mb-3">
                    Studio Voice AI
                </h1>
                <p className="text-(--text-secondary) text-lg max-w-2xl">
                    Transform your text or documents into incredibly realistic human speech using Deepgram Aura's advanced vocal models.
                </p>
            </div>

            <div className="custom-card p-6 md:p-8 bg-[radial-gradient(ellipse_at_top_right,rgba(99,102,241,0.05),transparent_50%)] relative overflow-hidden">
                <div className="absolute top-0 right-0 w-64 h-64 bg-indigo-500/10 rounded-full blur-3xl -mr-32 -mt-32 pointer-events-none"></div>

                <div className="space-y-6 relative z-10">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div className="space-y-2">
                            <label className="text-xs font-black uppercase tracking-widest text-(--text-muted) flex items-center gap-2">
                                <Type size={14} /> Optional Title
                            </label>
                            <input
                                type="text"
                                value={title}
                                onChange={(e) => setTitle(e.target.value)}
                                placeholder="E.g., Chapter 1 Narration"
                                className="w-full bg-(--bg-main) border border-(--border-subtle) rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/50 transition-all text-(--text-primary) placeholder:text-zinc-600"
                            />
                        </div>
                        
                        <div className="space-y-2">
                            <label className="text-xs font-black uppercase tracking-widest text-(--text-muted) flex items-center gap-2">
                                <Volume2 size={14} /> Voice Model
                            </label>
                            <div className="relative">
                                <select
                                    value={voice}
                                    onChange={(e) => setVoice(e.target.value)}
                                    className="w-full bg-(--bg-main) border border-(--border-subtle) rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/50 transition-all text-(--text-primary) appearance-none cursor-pointer"
                                >
                                    {VOICES.map(v => (
                                        <option key={v.id} value={v.id}>{v.name}</option>
                                    ))}
                                </select>
                                <div className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none text-(--text-muted)">
                                    ▼
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="space-y-2">
                        <label className="text-xs font-black uppercase tracking-widest text-(--text-muted) flex items-center justify-between">
                            <span className="flex items-center gap-2"><Type size={14} /> Spoken Text</span>
                            <span className="text-zinc-500 font-medium">{text.length} / 5000</span>
                        </label>
                        <textarea
                            value={text}
                            onChange={(e) => setText(e.target.value)}
                            placeholder="Type or paste the text you want the AI to speak... (Auto-detects Arabic, English, and dozens of other languages natively!)"
                            maxLength={5000}
                            className="w-full h-48 bg-(--bg-main) border border-(--border-subtle) rounded-xl px-4 py-4 text-sm focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/50 transition-all text-(--text-primary) placeholder:text-zinc-600 resize-y custom-scrollbar leading-relaxed"
                            dir="auto"
                        />
                    </div>

                    {status === 'error' && (
                        <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl text-red-500 text-sm animate-in fade-in">
                            <p className="font-bold flex items-center gap-2 mb-1">❌ Generation Failed</p>
                            <p className="opacity-90">{errorMsg}</p>
                        </div>
                    )}

                    {status === 'success' && resultUrl && (
                        <div className="p-5 bg-emerald-500/10 border border-emerald-500/20 rounded-xl animate-in slide-in-from-bottom-2 duration-300">
                            <p className="font-bold text-emerald-400 flex items-center gap-2 mb-3">
                                <PlayCircle size={18} /> Audio Generated Successfully!
                            </p>
                            <audio src={resultUrl} controls crossOrigin="anonymous" className="w-full h-10 accent-emerald-500" />
                        </div>
                    )}

                    <button
                        onClick={handleGenerate}
                        disabled={status === 'generating' || !text.trim()}
                        className="w-full btn-primary bg-indigo-500 hover:bg-indigo-400 py-4 text-sm font-black tracking-wide flex items-center justify-center gap-3 disabled:opacity-50 disabled:cursor-not-allowed group"
                    >
                        {status === 'generating' ? (
                            <>
                                <Loader2 size={18} className="animate-spin" />
                                Processing Neural Voice...
                            </>
                        ) : (
                            <>
                                <PlayCircle size={18} className="group-hover:scale-110 transition-transform" />
                                Generate Audio File
                            </>
                        )}
                    </button>
                    <p className="text-center text-[10px] font-bold uppercase tracking-widest text-(--text-muted) pt-2">
                        Powered by ElevenLabs Multilingual AI
                    </p>
                </div>
            </div>
        </div>
    );
};

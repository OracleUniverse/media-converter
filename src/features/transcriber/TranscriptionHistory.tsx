import React, { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { 
    Clock, 
    FileText, 
    Calendar, 
    Cpu, 
    RefreshCw, 
    AlertCircle, 
    Database,
    ChevronRight,
    Search,
    Trash2,
    Languages,
    Globe,
    Activity,
    Info,
    Volume2,
    FileJson,
    ListFilter,
    AlignLeft,
    AlignRight
} from 'lucide-react';

interface TranscriptionRecord {
    id: string;
    original_filename: string;
    file_size: number;
    duration: number;
    model_id: string;
    transcription_text: string;
    processing_time_ms: number;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    storage_path: string;
    error_message?: string;
    original_language?: string;
    transcription_metadata?: any;
    translations?: Record<string, { text: string; metadata: any }>;
    created_at: string;
    chunk_index: number;
    total_chunks: number;
    summary?: string;
    segments?: Array<{ start: number; end: number; speaker: string; text: string }>;
}

interface TranscriptionHistoryProps {
    userId: string;
}

export const TranscriptionHistory = ({ userId }: TranscriptionHistoryProps) => {
    const [records, setRecords] = useState<TranscriptionRecord[]>([]);
    const [loading, setLoading] = useState(true);
    const [selectedRecord, setSelectedRecord] = useState<TranscriptionRecord | null>(null);
    const [searchTerm, setSearchTerm] = useState('');
    const [isTranslating, setIsTranslating] = useState(false);
    const [activeView, setActiveView] = useState<'original' | string>('original');
    const [showLogs, setShowLogs] = useState<'transcription' | string | null>(null);
    const [isSummarizing, setIsSummarizing] = useState(false);
    const [audioUrl, setAudioUrl] = useState<string | null>(null);
    const audioRef = React.useRef<HTMLAudioElement>(null);
    const [activeIndex, setActiveIndex] = useState(-1);
    const [textAlign, setTextAlign] = useState<'auto' | 'ltr' | 'rtl'>('auto');
    const segmentRefs = React.useRef<{[key: number]: HTMLDivElement | null}>({});
    const segmentsRef = React.useRef<any[]>([]); // stable ref to avoid stale closures

    const fetchHistory = async () => {
        setLoading(true);
        try {
            const { data, error } = await supabase
                .from('trans_media_transcriptions')
                .select('*')
                .order('created_at', { ascending: false });

            if (error) throw error;
            setRecords(data || []);
        } catch (err) {
            console.error("Error fetching history:", err);
        } finally {
            setLoading(false);
        }
    };

    const handleDelete = async (e: React.MouseEvent, record: TranscriptionRecord) => {
        e.stopPropagation(); // Don't open the modal
        if (!confirm('Are you sure you want to delete this transcription? This will also remove any associated files.')) return;

        try {
            // 1. Delete from Storage
            if (record.storage_path) {
                await supabase.storage.from('trans_media_assets').remove([record.storage_path]);
            }

            // 2. Delete from Database
            const { error } = await supabase
                .from('trans_media_transcriptions')
                .delete()
                .eq('id', record.id);

            if (error) throw error;

            // 3. Update local state
            setRecords(prev => prev.filter(r => r.id !== record.id));
            if (selectedRecord?.id === record.id) setSelectedRecord(null);

        } catch (err) {
            console.error("Error deleting record:", err);
            alert("Failed to delete record. Please try again.");
        }
    };

    const handleTranslate = async (targetLang: 'English' | 'Arabic') => {
        if (!selectedRecord || isTranslating) return;
        
        setIsTranslating(true);
        console.log(`[UI] 🌐 Starting translation of "${selectedRecord.original_filename}" to ${targetLang}...`);

        try {
            const { data: { session } } = await supabase.auth.getSession();
            
            // 1. Call Edge Function
            const { data, error } = await supabase.functions.invoke('translate-text', {
                headers: { Authorization: `Bearer ${session?.access_token}` },
                body: { 
                    text: selectedRecord.transcription_text,
                    targetLanguage: targetLang 
                }
            });

            if (error || data.error) throw new Error(data.error || error.message);

            console.log(`[UI] ✅ Translation received. Saving to database...`);

            // 2. Save to Database
            const newTranslations = {
                ...(selectedRecord.translations || {}),
                [targetLang]: {
                    text: data.translatedText,
                    metadata: data.metadata
                }
            };

            const { error: dbError } = await supabase
                .from('trans_media_transcriptions')
                .update({ translations: newTranslations })
                .eq('id', selectedRecord.id);

            if (dbError) throw dbError;

            // 3. Update local state
            const updatedRecord = { 
                ...selectedRecord, 
                translations: newTranslations
            };
            setSelectedRecord(updatedRecord);
            setRecords(prev => prev.map(r => r.id === selectedRecord.id ? updatedRecord : r));
            setActiveView(targetLang);
            
            console.log(`[UI] ✨ Success! Translation fully stored and active.`);

        } catch (err: any) {
            console.error("[UI] ❌ Translation failed:", err);
            alert("Translation failed: " + err.message);
        } finally {
            setIsTranslating(false);
        }
    };

    const handleSummarize = async () => {
        if (!selectedRecord || isSummarizing) return;
        setIsSummarizing(true);
        try {
            const { data: { session } } = await supabase.auth.getSession();
            const { data, error } = await supabase.functions.invoke('summarize-text', {
                headers: { Authorization: `Bearer ${session?.access_token}` },
                body: { 
                    text: selectedRecord.transcription_text,
                    recordId: selectedRecord.id,
                    language: selectedRecord.original_language
                }
            });

            if (error || data.error) throw new Error(data.error || error.message);

            const updatedRecord = { ...selectedRecord, summary: data.summary };
            setSelectedRecord(updatedRecord);
            setRecords(prev => prev.map(r => r.id === selectedRecord.id ? updatedRecord : r));
        } catch (err: any) {
            console.error("Summarization failed:", err);
            alert("Failed to summarize: " + err.message);
        } finally {
            setIsSummarizing(false);
        }
    };

    const fetchAudioUrl = async (path: string) => {
        try {
            const { data, error } = await supabase.storage
                .from('trans_media_assets')
                .createSignedUrl(path, 3600); // 1 hour access
            
            if (error) throw error;
            setAudioUrl(data.signedUrl);
        } catch (err) {
            console.error("Error getting signed URL:", err);
        }
    };

    useEffect(() => {
        const loadAudio = async () => {
            // Populate segments ref for use in handleTimeUpdate (stable, no re-render)
            let segs = selectedRecord?.segments || [];
            if (typeof segs === 'string') {
                try { segs = JSON.parse(segs); } catch { segs = []; }
            }
            segmentsRef.current = segs as any[];
            setActiveIndex(-1);

            if (selectedRecord?.storage_path) {
                await fetchAudioUrl(selectedRecord.storage_path);
            } else {
                setAudioUrl(null);
            }
        };
        loadAudio();
    }, [selectedRecord?.id, selectedRecord?.storage_path, selectedRecord?.segments]);

    const seekAudio = (seconds: number) => {
        console.log(`[SYNC] 🎯 Seeking to ${seconds}s...`);
        if (audioRef.current) {
            audioRef.current.currentTime = seconds;
            // Always resume playback on click
            audioRef.current.play().catch(e => {
                // AbortError is benign — browser cancelled play due to load or quick seek
                if (e.name !== 'AbortError') {
                    console.warn("[SYNC] ⚠️ Playback failed:", e);
                }
            });
        } else {
            console.warn("[SYNC] ❌ Audio element ref not available");
        }
    };

    const handleTimeUpdate = () => {
        const t = audioRef.current?.currentTime ?? 0;
        const segs = segmentsRef.current;
        if (!segs.length) return;

        const newIndex = segs.findIndex(
            (seg: any) => t >= seg.start && t < seg.end
        );

        // Only trigger a re-render when the active segment actually changes
        setActiveIndex(prev => prev === newIndex ? prev : newIndex);
    };

    const formatSRT = (segments: any[]) => {
        if (!segments || segments.length === 0) return '';
        
        return segments.map((seg, i) => {
            const formatTime = (seconds: number) => {
                const h = Math.floor(seconds / 3600);
                const m = Math.floor((seconds % 3600) / 60);
                const s = Math.floor(seconds % 60);
                const ms = Math.floor((seconds % 1) * 1000);
                return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
            };
            
            return `${i + 1}\n${formatTime(seg.start)} --> ${formatTime(seg.end)}\n${seg.speaker ? `${seg.speaker}: ` : ''}${seg.text}\n\n`;
        }).join('');
    };

    const highlightSpeakers = (text: string) => {
        if (!text) return null;
        const parts = text.split(/(Speaker \d+:)/g);
        return parts.map((part, i) => {
            if (part?.match(/Speaker \d+:/)) {
                return <span key={i} className="font-black text-purple-400 mr-1">{part}</span>;
            }
            return <span key={i}>{part}</span>;
        });
    };

    useEffect(() => {
        fetchHistory();
    }, [userId]);

    const filteredRecords = records.filter(r => 
        r.original_filename.toLowerCase().includes(searchTerm.toLowerCase()) ||
        r.transcription_text?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        r.summary?.toLowerCase().includes(searchTerm.toLowerCase())
    );

    const formatDate = (dateStr: string) => {
        return new Date(dateStr).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    };

    const formatDuration = (seconds: number) => {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    };

    if (loading && records.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-20">
                <RefreshCw size={40} className="text-purple-500 animate-spin mb-4" />
                <p className="text-(--text-muted) font-medium">Loading history...</p>
            </div>
        );
    }

    return (
        <div className="max-w-7xl mx-auto py-8 px-4">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
                <div>
                    <h2 className="text-3xl font-black gradient-text mb-2">Transcription History</h2>
                    <p className="text-(--text-muted) text-sm flex items-center gap-2">
                        <Database size={14} />
                        {records.length} total transcriptions found
                    </p>
                </div>
                
                <div className="relative w-full md:w-80 group">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-(--text-muted) group-focus-within:text-purple-400 transition-colors" size={18} />
                    <input 
                        type="text" 
                        placeholder="Search files or content..." 
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="w-full bg-(--card-bg) border border-(--border-subtle) focus:border-purple-500/50 rounded-xl py-2.5 pl-10 pr-4 text-sm transition-all focus:outline-none focus:ring-2 focus:ring-purple-500/10"
                    />
                </div>
            </div>

            {filteredRecords.length === 0 ? (
                <div className="bg-(--card-bg) border border-(--border-subtle) rounded-3xl p-16 text-center">
                    <div className="w-16 h-16 bg-(--bg-main) rounded-2xl flex items-center justify-center mx-auto mb-6">
                        <FileText size={32} className="text-(--text-muted)" />
                    </div>
                    <h3 className="text-xl font-bold text-(--text-primary) mb-2">No transcriptions found</h3>
                    <p className="text-(--text-muted) max-w-sm mx-auto">
                        Your processed files will appear here. Start by transcribing some media!
                    </p>
                </div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {filteredRecords.map((record) => (
                        <div 
                            key={record.id}
                            onClick={() => setSelectedRecord(record)}
                            className="group bg-(--card-bg) border border-(--border-subtle) hover:border-purple-500/40 rounded-2xl p-6 transition-all cursor-pointer hover:shadow-2xl hover:shadow-purple-500/5 flex flex-col h-full relative overflow-hidden"
                        >
                            <div className="absolute top-0 right-0 p-4">
                                {record.status === 'completed' ? (
                                    <div className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]"></div>
                                ) : record.status === 'failed' ? (
                                    <div className="w-2 h-2 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]"></div>
                                ) : (
                                    <div className="w-2 h-2 rounded-full bg-amber-500 animate-pulse shadow-[0_0_8px_rgba(245,158,11,0.5)]"></div>
                                )}
                            </div>

                            <div className="flex items-start gap-4 mb-4">
                                <div className="w-12 h-12 rounded-xl bg-(--bg-main) border border-(--border-subtle) flex items-center justify-center shrink-0 group-hover:scale-110 transition-transform">
                                    <FileText size={24} className={record.status === 'completed' ? 'text-purple-400' : 'text-(--text-muted)'} />
                                </div>
                                <div className="overflow-hidden">
                                    <h4 className="font-bold text-(--text-primary) truncate group-hover:text-purple-400 transition-colors">
                                        {record.original_filename}
                                    </h4>
                                    <div className="flex items-center gap-2 text-[10px] text-(--text-muted) mt-1 font-medium tracking-wider uppercase">
                                        <Calendar size={10} />
                                        {formatDate(record.created_at)}
                                    </div>
                                </div>
                                <button 
                                    onClick={(e) => handleDelete(e, record)}
                                    className="ml-auto p-2 text-(--text-muted) hover:text-red-400 hover:bg-red-400/10 rounded-lg opacity-0 group-hover:opacity-100 transition-all"
                                    title="Delete transcription"
                                >
                                    <Trash2 size={16} />
                                </button>
                            </div>

                            <div className="grid grid-cols-2 gap-3 mb-6">
                                <div className="bg-(--bg-main) rounded-lg p-2.5 border border-(--border-subtle)/50">
                                    <p className="text-[10px] text-(--text-muted) uppercase font-bold mb-1 flex items-center gap-1">
                                        <Clock size={10} /> Duration
                                    </p>
                                    <p className="text-xs font-bold text-(--text-primary)">{formatDuration(record.duration)}</p>
                                </div>
                                <div className="bg-(--bg-main) rounded-lg p-2.5 border border-(--border-subtle)/50">
                                    <p className="text-[10px] text-(--text-muted) uppercase font-bold mb-1 flex items-center gap-1">
                                        <Cpu size={10} /> Processor
                                    </p>
                                    <p className="text-xs font-bold text-(--text-primary) truncate" title={record.model_id}>
                                        {record.model_id.split('/').pop()}
                                    </p>
                                </div>
                            </div>

                            <div className="mt-auto flex items-center justify-between pt-4 border-t border-(--border-subtle)/30">
                                <span className={`text-[10px] font-black uppercase tracking-widest px-2 py-1 rounded-md ${
                                    record.status === 'completed' ? 'bg-emerald-500/10 text-emerald-400' : 
                                    record.status === 'failed' ? 'bg-red-500/10 text-red-400' : 'bg-amber-500/10 text-amber-400'
                                }`}>
                                    {record.status}
                                </span>
                                
                                {record.total_chunks > 1 && (
                                    <span className="text-[10px] text-(--text-muted) font-bold">
                                        Part {record.chunk_index}/{record.total_chunks}
                                    </span>
                                )}

                                <ChevronRight size={16} className="text-(--text-muted) group-hover:translate-x-1 transition-transform" />
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {selectedRecord && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 md:p-10 animate-in fade-in duration-200">
                    <div 
                        className="absolute inset-0 bg-black/60 backdrop-blur-md"
                        onClick={() => setSelectedRecord(null)}
                    ></div>
                    <div className="relative w-full max-w-5xl bg-(--card-bg) border border-(--border-subtle) rounded-3xl shadow-2xl flex flex-col max-h-[90vh] overflow-hidden animate-in zoom-in-95 duration-200">
                        <div className="p-6 border-b border-(--border-subtle) flex items-center justify-between bg-(--bg-glass)">
                            <div>
                                <h3 className="text-xl font-bold text-(--text-primary) flex items-center gap-3">
                                    {selectedRecord.original_filename}
                                    <span className="text-xs font-normal text-(--text-muted) px-2 py-0.5 border border-(--border-subtle) rounded-full">
                                        {selectedRecord.total_chunks > 1 ? `Part ${selectedRecord.chunk_index}` : 'Full'}
                                    </span>
                                </h3>
                                <p className="text-xs text-(--text-muted) mt-1 flex items-center gap-2">
                                    Processed on {formatDate(selectedRecord.created_at)}
                                    {selectedRecord.original_language && (
                                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-widest ${
                                            selectedRecord.original_language === 'Arabic' ? 'bg-blue-500/10 text-blue-400' : 
                                            selectedRecord.original_language === 'English' ? 'bg-indigo-500/10 text-indigo-400' : 'bg-amber-500/10 text-amber-400'
                                        }`}>
                                            Source: {selectedRecord.original_language}
                                        </span>
                                    )}
                                </p>
                            </div>
                            <button 
                                onClick={() => setSelectedRecord(null)}
                                className="p-2 hover:bg-(--bg-main) rounded-xl transition-colors text-(--text-muted) hover:text-(--text-primary)"
                            >
                                <RefreshCw size={20} className="rotate-45" />
                            </button>
                        </div>
                        
                        <div className="px-6 py-2 bg-red-400/5 border-b border-red-500/10 flex items-center justify-between">
                            <span className="text-[10px] text-red-400 font-bold tracking-widest uppercase">Dangerous Area</span>
                            <button 
                                onClick={(e) => handleDelete(e, selectedRecord)}
                                className="flex items-center gap-2 text-xs font-bold text-red-500 hover:text-red-400 transition-colors px-3 py-1 hover:bg-red-400/10 rounded-lg"
                            >
                                <Trash2 size={14} />
                                Delete Permanently
                            </button>
                        </div>

                        {/* Translation & Utility Controls */}
                        <div className="bg-(--bg-main) border-b border-(--border-subtle) px-6 py-3 flex flex-wrap items-center justify-between gap-4">
                            <div className="flex items-center gap-2">
                                <button 
                                    onClick={() => setActiveView('original')}
                                    className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${activeView === 'original' ? 'bg-purple-500 text-white shadow-lg shadow-purple-500/20' : 'bg-(--card-bg) text-(--text-muted) hover:text-(--text-primary)'}`}
                                >
                                    Original
                                </button>
                                {Object.keys(selectedRecord.translations || {}).map(lang => (
                                    <button 
                                        key={lang}
                                        onClick={() => setActiveView(lang)}
                                        className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${activeView === lang ? 'bg-emerald-500 text-white shadow-lg shadow-emerald-500/20' : 'bg-(--card-bg) text-(--text-muted) hover:text-(--text-primary)'}`}
                                    >
                                        {lang}
                                    </button>
                                ))}
                            </div>

                            <div className="flex items-center gap-3">
                                <button 
                                    onClick={handleSummarize}
                                    disabled={isSummarizing || !!selectedRecord.summary}
                                    className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-[10px] font-black bg-amber-500/10 text-amber-500 hover:bg-amber-500/20 transition-all border border-amber-500/20 disabled:opacity-50"
                                >
                                    {isSummarizing ? <RefreshCw size={12} className="animate-spin" /> : <ListFilter size={12} />}
                                    {selectedRecord.summary ? 'Summarized' : 'Generate Summary'}
                                </button>
                                <span className="w-px h-4 bg-(--border-subtle) mx-1"></span>
                                <span className="text-[10px] text-(--text-muted) font-bold uppercase tracking-widest">AI Translation:</span>
                                {selectedRecord.original_language !== 'Arabic' && (
                                    <button 
                                        onClick={() => handleTranslate('Arabic')}
                                        disabled={isTranslating}
                                        className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-[10px] font-black bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 transition-all border border-blue-500/20 disabled:opacity-30 disabled:cursor-not-allowed"
                                    >
                                        {isTranslating ? <RefreshCw size={12} className="animate-spin" /> : <Languages size={12} />}
                                        {selectedRecord.translations?.['Arabic'] ? 'Update Arabic' : 'Translate to Arabic'}
                                    </button>
                                )}
                                {selectedRecord.original_language !== 'English' && (
                                    <button 
                                        onClick={() => handleTranslate('English')}
                                        disabled={isTranslating}
                                        className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-[10px] font-black bg-indigo-500/10 text-indigo-400 hover:bg-indigo-500/20 transition-all border border-indigo-500/20 disabled:opacity-30 disabled:cursor-not-allowed"
                                    >
                                        {isTranslating ? <RefreshCw size={12} className="animate-spin" /> : <Languages size={12} />}
                                        {selectedRecord.translations?.['English'] ? 'Update English' : 'Translate to English'}
                                    </button>
                                )}
                            </div>
                        </div>
                        
                        <div className="flex-1 overflow-y-auto p-8 custom-scrollbar bg-[radial-gradient(circle_at_top_right,rgba(168,85,247,0.03),transparent_40%)]">
                            {selectedRecord.status === 'completed' ? (
                                <div className="space-y-8">
                                    {/* Audio Player Section - always rendered so audioRef is never null */}
                                    <div className={`bg-(--bg-main) border border-(--border-subtle) rounded-2xl p-4 flex items-center gap-6 shadow-sm transition-opacity ${audioUrl ? 'opacity-100' : 'opacity-0 pointer-events-none h-0 overflow-hidden p-0 border-0'}`}>
                                        <div className="w-10 h-10 rounded-full bg-purple-500/10 flex items-center justify-center text-purple-400">
                                            <Volume2 size={20} />
                                        </div>
                                        <div className="flex-1">
                                            <p className="text-[10px] font-black uppercase tracking-widest text-(--text-muted) mb-2">Recording Playback</p>
                                            <audio 
                                                ref={audioRef}
                                                src={audioUrl ?? undefined} 
                                                controls 
                                                crossOrigin="anonymous"
                                                onTimeUpdate={handleTimeUpdate}
                                                className="w-full h-10 accent-purple-500"
                                                onError={(e) => {
                                                    console.error("Audio playback error:", e);
                                                }}
                                            >
                                                {audioUrl && <source src={audioUrl} type="audio/mpeg" />}
                                                </audio>
                                            </div>
                                    </div>

                                    {/* Summary Section */}
                                    {selectedRecord.summary && (
                                        <div className="bg-amber-500/5 border border-amber-500/10 rounded-2xl p-6 relative overflow-hidden group">
                                            <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                                                <ListFilter size={64} className="text-amber-500" />
                                            </div>
                                            <h4 className="text-amber-500 text-xs font-black uppercase tracking-widest mb-4 flex items-center gap-2">
                                                <Activity size={14} /> 3-Point Quick Summary
                                            </h4>
                                            <div className="space-y-3 relative z-10">
                                                {selectedRecord.summary.split('\n').filter(s => s.trim()).map((point, i) => (
                                                    <div key={i} className="flex gap-3 text-sm text-(--text-secondary) leading-relaxed">
                                                        <span className="text-amber-500/50 font-bold">•</span>
                                                        <p>{point.replace(/^[*-]\s*/, '')}</p>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    <div className="flex flex-wrap gap-4">
                                        {selectedRecord.transcription_metadata?.process_time_ms && (
                                            <div className={`flex-1 min-w-[200px] bg-purple-500/5 border border-purple-500/10 rounded-xl p-3 flex items-center justify-between transition-all ${showLogs === 'transcription' ? 'border-purple-500/40 bg-purple-500/10' : ''}`}>
                                                <div className="flex items-center gap-2 text-purple-400">
                                                    <Activity size={14} />
                                                    <span className="text-[10px] font-bold uppercase tracking-wider">Transcription Logs</span>
                                                </div>
                                                <button 
                                                    onClick={() => setShowLogs(showLogs === 'transcription' ? null : 'transcription')}
                                                    className="text-[10px] font-bold text-purple-400 underline underline-offset-4"
                                                >
                                                    {showLogs === 'transcription' ? 'Hide' : 'View'}
                                                </button>
                                            </div>
                                        )}
                                        {Object.keys(selectedRecord.translations || {}).map(lang => (
                                            <div key={lang} className={`flex-1 min-w-[200px] bg-emerald-500/5 border border-emerald-500/10 rounded-xl p-3 flex items-center justify-between transition-all ${showLogs === lang ? 'border-emerald-500/40 bg-emerald-500/10' : ''}`}>
                                                <div className="flex items-center gap-2 text-emerald-400">
                                                    <Activity size={14} />
                                                    <span className="text-[10px] font-bold uppercase tracking-wider">{lang} AI Logs</span>
                                                </div>
                                                <button 
                                                    onClick={() => setShowLogs(showLogs === lang ? null : lang)}
                                                    className="text-[10px] font-bold text-emerald-400 underline underline-offset-4"
                                                >
                                                    {showLogs === lang ? 'Hide' : 'View'}
                                                </button>
                                            </div>
                                        ))}
                                    </div>

                                    {showLogs && (
                                        <div className={`bg-zinc-900 border ${showLogs === 'transcription' ? 'border-purple-500/20' : 'border-emerald-500/20'} rounded-2xl p-5 font-mono text-[11px] text-zinc-400 animate-in slide-in-from-top-2 duration-200 shadow-2xl`}>
                                            <p className={`mb-3 ${showLogs === 'transcription' ? 'text-purple-500' : 'text-emerald-500'} border-b border-zinc-800 pb-2 flex items-center gap-2 uppercase tracking-widest font-black`}>
                                                <Info size={12} /> {showLogs === 'transcription' ? 'Transcription' : `${showLogs} Translation`} AI Metadata
                                            </p>
                                            <div className="grid grid-cols-2 gap-x-12 gap-y-2 pt-1">
                                                <div className="space-y-2">
                                                    <p className="flex justify-between"><span>Model:</span> <span className="text-zinc-200">{(showLogs === 'transcription' ? selectedRecord.transcription_metadata : selectedRecord.translations?.[showLogs]?.metadata)?.model || 'Unknown'}</span></p>
                                                    <p className="flex justify-between"><span>Processing:</span> <span className="text-zinc-200">{(showLogs === 'transcription' ? selectedRecord.transcription_metadata : selectedRecord.translations?.[showLogs]?.metadata)?.process_time_ms || 0}ms</span></p>
                                                    <p className="flex justify-between"><span>Time:</span> <span className="text-zinc-200">{new Date((showLogs === 'transcription' ? selectedRecord.transcription_metadata : selectedRecord.translations?.[showLogs]?.metadata)?.timestamp || Date.now()).toLocaleTimeString()}</span></p>
                                                </div>
                                                <div className="space-y-2">
                                                    <p className="flex justify-between"><span>Input:</span> <span className="text-zinc-200">{(showLogs === 'transcription' ? selectedRecord.transcription_metadata : selectedRecord.translations?.[showLogs]?.metadata)?.input_length || 'N/A'} chars</span></p>
                                                    <p className="flex justify-between"><span>Output:</span> <span className="text-zinc-200">{(showLogs === 'transcription' ? selectedRecord.transcription_metadata : selectedRecord.translations?.[showLogs]?.metadata)?.output_length || 'N/A'} chars</span></p>
                                                    <p className="flex justify-between text-zinc-100 font-bold border-t border-zinc-800/50 pt-1">
                                                        <span>Tokens:</span> 
                                                        <span>{(showLogs === 'transcription' ? selectedRecord.transcription_metadata : selectedRecord.translations?.[showLogs]?.metadata)?.usage?.total_tokens || 'Unknown'}</span>
                                                    </p>
                                                    {showLogs === 'transcription' && (
                                                        <p className="flex justify-between text-purple-400 font-bold border-t border-zinc-800/50 pt-1">
                                                            <span>Segments:</span> 
                                                            <span>{selectedRecord.segments?.length || 0} found</span>
                                                        </p>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    )}

                                    <div className="flex items-center justify-between mt-6 mb-2">
                                        <h3 className="text-sm font-bold text-zinc-300">Transcription Details</h3>
                                        <div className="flex items-center gap-1 bg-zinc-900/50 p-1 rounded-lg border border-zinc-800">
                                            <button 
                                                onClick={() => setTextAlign('ltr')}
                                                className={`p-1.5 rounded-md transition-all ${textAlign === 'ltr' ? 'bg-purple-500/20 text-purple-400' : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'}`}
                                                title="Left to Right"
                                            >
                                                <AlignLeft size={14} />
                                            </button>
                                            <button 
                                                onClick={() => setTextAlign('auto')}
                                                className={`p-1.5 rounded-md text-[10px] font-black uppercase tracking-wider transition-all px-2 ${textAlign === 'auto' ? 'bg-purple-500/20 text-purple-400' : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'}`}
                                                title="Auto Detect Language"
                                            >
                                                Auto
                                            </button>
                                            <button 
                                                onClick={() => setTextAlign('rtl')}
                                                className={`p-1.5 rounded-md transition-all ${textAlign === 'rtl' ? 'bg-purple-500/20 text-purple-400' : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'}`}
                                                title="Right to Left"
                                            >
                                                <AlignRight size={14} />
                                            </button>
                                        </div>
                                    </div>

                                    <div className={`prose prose-invert max-w-none transition-all duration-300 ${isTranslating ? 'opacity-30 blur-sm' : 'opacity-100 blur-0'}`}>
                                        {(() => {
                                            let segs = selectedRecord.segments;
                                            if (typeof segs === 'string') {
                                                try { segs = JSON.parse(segs); } catch { segs = []; }
                                            }
                                            
                                            if (activeView === 'original' && segs && segs.length > 0) {
                                                console.log(`[SYNC] 📜 Rendering ${segs.length} interactive segments`);
                                                return (
                                                    <div className="space-y-4">
                                                        <div className="flex items-center gap-2 mb-4 p-2 bg-purple-500/5 border border-purple-500/10 rounded-lg">
                                                            <div className="w-2 h-2 rounded-full bg-purple-500 animate-pulse"></div>
                                                            <span className="text-[10px] font-bold text-purple-400 uppercase tracking-widest">Interactive Mode: Click text to seek audio</span>
                                                        </div>
                                                        {segs.map((seg: any, i: number) => {
                                                            const isCurrentActive = i === activeIndex;
                                                            return (
                                                                <div 
                                                                    key={i} 
                                                                    ref={el => { segmentRefs.current[i] = el; }}
                                                                    onClick={() => seekAudio(seg.start)}
                                                                    className={`group/seg cursor-pointer p-4 -mx-4 rounded-2xl transition-all border-2 ${
                                                                        isCurrentActive 
                                                                        ? 'bg-purple-500/10 border-purple-500/40 shadow-lg shadow-purple-500/5 translate-x-1' 
                                                                        : 'border-transparent hover:bg-purple-500/5 hover:border-purple-500/10'
                                                                    } active:bg-purple-500/20`}
                                                                    dir={textAlign}
                                                                >
                                                                    <div className="flex items-center gap-3 mb-2" dir="ltr">
                                                                        <div className={`w-1.5 h-1.5 rounded-full transition-all ${isCurrentActive ? 'bg-purple-500 scale-125 shadow-[0_0_8px_rgba(168,85,247,0.8)]' : 'bg-purple-500/20'}`}></div>
                                                                        <span className={`text-[10px] font-black transition-colors ${isCurrentActive ? 'text-purple-400' : 'text-purple-400/40 group-hover/seg:text-purple-400/60'}`}>
                                                                            {formatDuration(seg.start)}
                                                                        </span>
                                                                        <span className="text-[10px] font-bold text-(--text-muted) uppercase tracking-widest">
                                                                            {seg.speaker || 'Speaker'}
                                                                        </span>
                                                                    </div>
                                                                    <p className={`leading-relaxed transition-colors ${isCurrentActive ? 'text-(--text-primary) font-medium' : 'text-(--text-secondary)'}`}>
                                                                        {seg.text}
                                                                    </p>
                                                                </div>
                                                            );
                                                        })}
                                                    </div>
                                                );
                                            }
                                            
                                            console.log(`[SYNC] ℹ️ Using standard paragraph rendering (No segments found)`);
                                            return (
                                                <div className="space-y-4">
                                                    {activeView === 'original' && (
                                                        <div className="flex items-center gap-2 mb-4 p-2 bg-amber-500/5 border border-amber-500/10 rounded-lg">
                                                            <AlertCircle size={14} className="text-amber-500" />
                                                            <span className="text-[10px] font-bold text-amber-400 uppercase tracking-widest">Interactive data unavailable for this recording</span>
                                                        </div>
                                                    )}
                                                    {(activeView === 'original' ? selectedRecord.transcription_text : selectedRecord.translations?.[activeView]?.text)?.split('\n').map((para: string, i: number) => (
                                                        <p key={i} dir={textAlign} className={`text-(--text-secondary) leading-relaxed mb-4 ${activeView === 'Arabic' || (activeView === 'original' && selectedRecord.original_language === 'Arabic') ? 'font-arabic' : ''}`}>
                                                            {highlightSpeakers(para)}
                                                        </p>
                                                    ))}
                                                </div>
                                            );
                                        })()}
                                    </div>
                                </div>
                            ) : selectedRecord.status === 'failed' ? (
                                <div className="flex flex-col items-center justify-center py-12 text-center">
                                    <AlertCircle size={48} className="text-red-400 mb-4" />
                                    <h4 className="text-lg font-bold text-red-400 mb-2">Processing Failed</h4>
                                    <p className="text-(--text-muted) max-w-md">{selectedRecord.error_message || "Unknown error occurred during transcription."}</p>
                                </div>
                            ) : (
                                <div className="flex flex-col items-center justify-center py-20 text-center">
                                    <RefreshCw size={48} className="text-amber-400 animate-spin mb-4" />
                                    <h4 className="text-lg font-bold text-amber-400 mb-2">Still Processing</h4>
                                    <p className="text-(--text-muted)">The AI is currently analyzing this file. Check back in a moment.</p>
                                </div>
                            )}
                        </div>

                        <div className="p-6 border-t border-(--border-subtle) bg-(--bg-glass) flex items-center justify-between">
                            <div className="flex gap-6">
                                <div className="flex flex-col">
                                    <span className="text-[10px] text-(--text-muted) uppercase font-black tracking-widest">Model</span>
                                    <span className="text-sm font-bold">{selectedRecord.model_id}</span>
                                </div>
                                <div className="flex flex-col">
                                    <span className="text-[10px] text-(--text-muted) uppercase font-black tracking-widest">Processing Time</span>
                                    <span className="text-sm font-bold">{(selectedRecord.processing_time_ms / 1000).toFixed(2)}s</span>
                                </div>
                            </div>
                            
                            <div className="flex flex-wrap gap-3">
                                <button 
                                    onClick={() => {
                                        const blob = new Blob([selectedRecord.transcription_text || ''], { type: 'text/plain' });
                                        const url = URL.createObjectURL(blob);
                                        const a = document.createElement('a');
                                        a.href = url;
                                        a.download = `${selectedRecord.original_filename}_transcription.txt`;
                                        a.click();
                                    }}
                                    disabled={selectedRecord.status !== 'completed'}
                                    className="btn-primary px-5 py-2 text-xs font-bold flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    <FileText size={14} />
                                    Text (.txt)
                                </button>

                                {selectedRecord.segments && selectedRecord.segments.length > 0 && (
                                    <button 
                                        onClick={() => {
                                            const srtContent = formatSRT(selectedRecord.segments || []);
                                            const blob = new Blob([srtContent], { type: 'text/plain' });
                                            const url = URL.createObjectURL(blob);
                                            const a = document.createElement('a');
                                            a.href = url;
                                            a.download = `${selectedRecord.original_filename}_subtitles.srt`;
                                            a.click();
                                        }}
                                        className="bg-indigo-500 hover:bg-indigo-600 text-white shadow-lg shadow-indigo-500/20 px-5 py-2 rounded-xl text-xs font-bold flex items-center gap-2 transition-all"
                                    >
                                        <FileJson size={14} />
                                        Subtitles (.srt)
                                    </button>
                                )}
                                
                                {Object.entries(selectedRecord.translations || {}).map(([lang, data]) => (
                                    <button 
                                        key={lang}
                                        onClick={() => {
                                            const blob = new Blob([data.text || ''], { type: 'text/plain' });
                                            const url = URL.createObjectURL(blob);
                                            const a = document.createElement('a');
                                            a.href = url;
                                            a.download = `${selectedRecord.original_filename}_translated_${lang}.txt`;
                                            a.click();
                                        }}
                                        className="bg-emerald-500 hover:bg-emerald-600 text-white shadow-lg shadow-emerald-500/20 px-5 py-2 rounded-xl text-xs font-bold flex items-center gap-2 transition-all"
                                    >
                                        <Globe size={14} />
                                        {lang} (.txt)
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

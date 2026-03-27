import React, { useEffect, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import type { VirtuosoHandle } from 'react-virtuoso';
import { supabase } from '../../lib/supabase';
import { 
    Clock, 
    FileText, 
    Calendar, 
    RefreshCw, 
    AlertCircle, 
    Database,
    ChevronRight,
    Search,
    Trash2,
    Languages,
    Activity,
    Volume2,
    ListFilter,
    AlignLeft,
    AlignRight,
    Download
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
    const [isSummarizing, setIsSummarizing] = useState(false);
    const [audioUrl, setAudioUrl] = useState<string | null>(null);
    const audioRef = React.useRef<HTMLAudioElement>(null);
    const [activeIndex, setActiveIndex] = useState(-1);
    const [currentTime, setCurrentTime] = useState(0);
    const [textAlign, setTextAlign] = useState<'auto' | 'ltr' | 'rtl'>('auto');
    const segmentsRef = React.useRef<any[]>([]); // stable ref to avoid stale closures
    const virtuosoRef = React.useRef<VirtuosoHandle>(null);

    // Polling logic for background processing
    useEffect(() => {
        let pollInterval: any;
        
        if (selectedRecord?.status === 'processing' || selectedRecord?.status === 'pending') {
            const rid = selectedRecord.id;
            console.log(`[POLL] 🔄 Starting poll for record ${rid}...`);
            pollInterval = setInterval(async () => {
                const { data, error } = await supabase
                    .from('trans_media_transcriptions')
                    .select('*')
                    .eq('id', rid)
                    .single();
                
                if (error) {
                    console.error("[POLL] ❌ Error:", error.message);
                    return;
                }

                if (data && data.status !== selectedRecord.status) {
                    console.log(`[POLL] ✨ Status changed to ${data.status}! Updating UI.`);
                    setSelectedRecord(data);
                    setRecords(prev => prev.map(r => r.id === data.id ? data : r));
                    if (data.status === 'completed' || data.status === 'failed') {
                        clearInterval(pollInterval);
                    }
                }
            }, 3000);
        }

        return () => {
            if (pollInterval) clearInterval(pollInterval);
        };
    }, [selectedRecord?.id, selectedRecord?.status]);

    // Auto-scroll logic for virtuoso
    useEffect(() => {
        if (activeIndex !== -1 && virtuosoRef.current) {
            virtuosoRef.current.scrollToIndex({
                index: activeIndex,
                align: 'center',
                behavior: 'smooth'
            });
        }
    }, [activeIndex]);

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
        setCurrentTime(t);
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
        <div className="h-[calc(100vh-140px)] flex flex-col md:flex-row bg-(--card-bg) border border-(--border-subtle) rounded-3xl overflow-hidden shadow-2xl mx-4 my-4">
            {/* Left Pane: Record List */}
            <div className={`flex-col ${selectedRecord ? 'hidden md:flex w-80 lg:w-96' : 'flex w-full'} border-r border-(--border-subtle) bg-(--bg-glass) transition-all overflow-hidden`}>
                <div className="p-6 border-b border-(--border-subtle) bg-(--card-bg)/50">
                    <div className="flex items-center justify-between mb-4">
                        <h2 className="text-xl font-black gradient-text">History</h2>
                        <div className="px-2 py-0.5 bg-purple-500/10 border border-purple-500/20 rounded-full">
                            <p className="text-[10px] text-purple-400 font-bold flex items-center gap-1">
                                <Database size={10} /> {records.length}
                            </p>
                        </div>
                    </div>
                    <div className="relative group">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-(--text-muted) group-focus-within:text-purple-400 transition-colors" size={14} />
                        <input 
                            type="text" 
                            placeholder="Search records..." 
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="w-full bg-(--bg-main) border border-(--border-subtle) focus:border-purple-500/50 rounded-xl py-2 pl-9 pr-3 text-xs transition-all focus:outline-none focus:ring-2 focus:ring-purple-500/10 placeholder:text-(--text-muted)/50"
                        />
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto custom-scrollbar p-3 space-y-2">
                    {filteredRecords.length === 0 ? (
                        <div className="py-20 text-center opacity-50">
                            <FileText size={32} className="text-(--text-muted) mx-auto mb-4 stroke-1" />
                            <p className="text-xs font-medium text-(--text-muted)">No matching records</p>
                        </div>
                    ) : (
                        filteredRecords.map((record) => (
                            <button
                                key={record.id}
                                onClick={() => setSelectedRecord(record)}
                                className={`w-full text-left p-4 rounded-2xl transition-all group relative border ${selectedRecord?.id === record.id ? 'bg-purple-500/10 border-purple-500/30' : 'hover:bg-(--bg-main)/80 border-transparent hover:border-(--border-subtle)'}`}
                            >
                                <div className="flex items-start gap-4">
                                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 border transition-all ${selectedRecord?.id === record.id ? 'bg-purple-500 shadow-lg shadow-purple-500/20 text-white border-purple-400' : 'bg-(--card-bg) text-(--text-muted) border-(--border-subtle)'}`}>
                                        <FileText size={18} />
                                    </div>
                                    <div className="flex-1 overflow-hidden">
                                        <p className={`font-bold text-sm truncate mb-1 ${selectedRecord?.id === record.id ? 'text-purple-400' : 'text-(--text-primary)'}`}>
                                            {record.original_filename}
                                        </p>
                                        <div className="flex items-center gap-3 text-[10px] text-(--text-muted) font-medium">
                                            <span className="flex items-center gap-1"><Calendar size={10} /> {formatDate(record.created_at).split(',')[0]}</span>
                                            <span className="flex items-center gap-1"><Clock size={10} /> {formatDuration(record.duration)}</span>
                                        </div>
                                    </div>
                                    <div className="shrink-0 pt-1">
                                        <div className={`w-2 h-2 rounded-full ring-4 ring-opacity-10 ${
                                            record.status === 'completed' ? 'bg-emerald-500 ring-emerald-500' : 
                                            record.status === 'failed' ? 'bg-red-500 ring-red-500' : 'bg-amber-500 ring-amber-500 animate-pulse'
                                        }`} />
                                    </div>
                                </div>
                            </button>
                        ))
                    )}
                </div>
            </div>

            {/* Right Pane: Content Detail */}
            <div className={`flex-1 flex flex-col bg-(--bg-main) relative overflow-hidden ${!selectedRecord ? 'hidden md:flex' : 'flex'}`}>
                {selectedRecord ? (
                    <>
                        {/* Header Area */}
                        <div className="px-8 py-6 border-b border-(--border-subtle) bg-(--card-bg)/80 backdrop-blur-xl flex items-center justify-between z-10 transition-all">
                            <div className="flex items-center gap-5 min-w-0">
                                <button 
                                    onClick={() => setSelectedRecord(null)}
                                    className="md:hidden p-2.5 hover:bg-(--bg-main) rounded-2xl text-(--text-muted) border border-(--border-subtle) transition-colors"
                                >
                                    <ChevronRight size={20} className="rotate-180" />
                                </button>
                                <div className="min-w-0 overflow-hidden">
                                    <div className="flex items-center gap-3 mb-1.5 flex-wrap">
                                        <h3 className="text-xl font-black text-(--text-primary) truncate">
                                            {selectedRecord.original_filename}
                                        </h3>
                                        <span className={`text-[10px] font-black uppercase tracking-widest px-2.5 py-1 rounded-full border ${
                                            selectedRecord.status === 'completed' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 
                                            selectedRecord.status === 'failed' ? 'bg-red-500/10 text-red-400 border-red-500/20' : 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                                        }`}>
                                            {selectedRecord.status}
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-4 text-[10px] text-(--text-muted) font-medium">
                                        <span className="flex items-center gap-1.5"><Calendar size={12} /> {formatDate(selectedRecord.created_at)}</span>
                                        <span className="w-1 h-1 rounded-full bg-(--border-subtle)" />
                                        <span className="flex items-center gap-1.5"><Clock size={12} /> {formatDuration(selectedRecord.duration)}</span>
                                    </div>
                                </div>
                            </div>
                            
                            <div className="flex items-center gap-3 shrink-0">
                                <button 
                                    onClick={(e) => handleDelete(e, selectedRecord)}
                                    className="p-3 text-red-400 hover:bg-red-500/10 border border-transparent hover:border-red-500/20 rounded-2xl transition-all group"
                                    title="Delete transcription"
                                >
                                    <Trash2 size={20} className="group-hover:scale-110 transition-transform" />
                                </button>
                            </div>
                        </div>

                        {/* Toolbar / Actions & Compact Player */}
                        <div className="px-8 py-3 border-b border-(--border-subtle) bg-(--card-bg)/30 flex flex-wrap items-center justify-between gap-6 z-10 shadow-sm">
                            <div className="flex items-center gap-4 flex-1">
                                <div className="flex items-center gap-1 bg-(--bg-main)/50 p-1 rounded-xl border border-(--border-subtle) shadow-inner">
                                    <button 
                                        onClick={() => setActiveView('original')}
                                        className={`px-4 py-1.5 rounded-lg text-[10px] font-black transition-all ${activeView === 'original' ? 'bg-purple-500 text-white shadow-lg shadow-purple-500/30' : 'text-(--text-muted) hover:text-(--text-primary) hover:bg-(--bg-main)'}`}
                                    >
                                        ORIGINAL
                                    </button>
                                    {Object.keys(selectedRecord.translations || {}).map(lang => (
                                        <button 
                                            key={lang}
                                            onClick={() => setActiveView(lang)}
                                            className={`px-4 py-1.5 rounded-lg text-[10px] font-black transition-all ${activeView === lang ? 'bg-emerald-500 text-white shadow-lg shadow-emerald-500/30' : 'text-(--text-muted) hover:text-(--text-primary) hover:bg-(--bg-main)'}`}
                                        >
                                            {lang.toUpperCase()}
                                        </button>
                                    ))}
                                </div>

                                {/* Compact Integrated Player */}
                                {audioUrl && selectedRecord.status === 'completed' && (
                                    <div className="flex-1 max-w-md flex items-center gap-4 bg-(--bg-main)/40 px-4 py-1.5 rounded-xl border border-(--border-subtle) group">
                                        <Volume2 size={14} className="text-purple-400 shrink-0" />
                                        <audio 
                                            ref={audioRef}
                                            src={audioUrl} 
                                            controls 
                                            crossOrigin="anonymous"
                                            onTimeUpdate={handleTimeUpdate}
                                            className="h-6 w-full accent-purple-500 opacity-60 hover:opacity-100 transition-opacity"
                                        />
                                        <span className="text-[10px] font-mono text-purple-400/80 shrink-0 tabular-nums">
                                            {formatDuration(currentTime)}
                                        </span>
                                    </div>
                                )}
                            </div>

                            <div className="flex items-center gap-4">
                                <div className="flex items-center gap-2">
                                    <button 
                                        onClick={handleSummarize}
                                        disabled={isSummarizing || !!selectedRecord.summary}
                                        className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-[9px] font-black tracking-widest uppercase bg-amber-500/10 text-amber-500 hover:bg-amber-500/20 transition-all border border-amber-500/20 disabled:opacity-50"
                                    >
                                        {isSummarizing ? <RefreshCw size={10} className="animate-spin" /> : <ListFilter size={10} />}
                                        {selectedRecord.summary ? 'Summarized' : 'Summarize'}
                                    </button>
                                    
                                    <div className="flex gap-1.5">
                                        {selectedRecord.original_language !== 'Arabic' && (
                                            <button 
                                                onClick={() => handleTranslate('Arabic')}
                                                disabled={isTranslating}
                                                className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-[9px] font-black tracking-widest uppercase bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 transition-all border border-blue-500/20 disabled:opacity-30"
                                            >
                                                {isTranslating ? <RefreshCw size={10} className="animate-spin" /> : <Languages size={10} />} Arabic
                                            </button>
                                        )}
                                        {selectedRecord.original_language !== 'English' && (
                                            <button 
                                                onClick={() => handleTranslate('English')}
                                                disabled={isTranslating}
                                                className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-[9px] font-black tracking-widest uppercase bg-indigo-500/10 text-indigo-400 hover:bg-indigo-500/20 transition-all border border-indigo-500/20 disabled:opacity-30"
                                            >
                                                {isTranslating ? <RefreshCw size={10} className="animate-spin" /> : <Languages size={10} />} English
                                            </button>
                                        )}
                                    </div>
                                </div>
                                
                                <div className="flex items-center gap-1 bg-(--bg-main)/50 p-1 rounded-lg border border-(--border-subtle)">
                                    <button 
                                        onClick={() => setTextAlign('ltr')}
                                        className={`p-1.5 rounded-md transition-all ${textAlign === 'ltr' ? 'bg-purple-500/20 text-purple-400' : 'text-(--text-muted) hover:text-(--text-primary)'}`}
                                    >
                                        <AlignLeft size={14} />
                                    </button>
                                    <button 
                                        onClick={() => setTextAlign('rtl')}
                                        className={`p-1.5 rounded-md transition-all ${textAlign === 'rtl' ? 'bg-purple-500/20 text-purple-400' : 'text-(--text-muted) hover:text-(--text-primary)'}`}
                                    >
                                        <AlignRight size={14} />
                                    </button>
                                </div>

                                <div className="flex items-center gap-1.5 bg-purple-500/5 p-1 rounded-xl border border-purple-500/10">
                                    <button 
                                        onClick={() => {
                                            const blob = new Blob([activeView === 'original' ? selectedRecord.transcription_text : selectedRecord.translations?.[activeView]?.text || ''], { type: 'text/plain' });
                                            const url = URL.createObjectURL(blob);
                                            const a = document.createElement('a');
                                            a.href = url;
                                            a.download = `${selectedRecord.original_filename}_${activeView}.txt`;
                                            a.click();
                                        }}
                                        className="p-2 text-purple-400 hover:bg-purple-500/10 rounded-lg transition-all"
                                        title="Export TXT"
                                    >
                                        <FileText size={16} />
                                    </button>
                                    {selectedRecord.segments && activeView === 'original' && (
                                        <button 
                                            onClick={() => {
                                                const srtContent = formatSRT(selectedRecord.segments || []);
                                                const blob = new Blob([srtContent], { type: 'text/plain' });
                                                const url = URL.createObjectURL(blob);
                                                const a = document.createElement('a');
                                                a.href = url;
                                                a.download = `${selectedRecord.original_filename}.srt`;
                                                a.click();
                                            }}
                                            className="p-2 text-purple-400 hover:bg-purple-500/10 rounded-lg transition-all border-l border-purple-500/10"
                                            title="Export SRT"
                                        >
                                            <Download size={16} />
                                        </button>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Content Area - Single Column centered */}
                        <div className="flex-1 overflow-y-auto custom-scrollbar bg-[radial-gradient(circle_at_top_right,rgba(168,85,247,0.015),transparent_40%)]">
                            {selectedRecord.status === 'completed' ? (
                                <div className="max-w-4xl mx-auto p-12 space-y-12">
                                    {/* Quick Summary moved inside content flow */}
                                    {selectedRecord.summary && (
                                        <div className="bg-amber-500/5 border border-amber-500/10 rounded-3xl p-8 relative overflow-hidden group shadow-lg">
                                            <div className="absolute -top-10 -right-10 opacity-5 rotate-12">
                                                <ListFilter size={160} className="text-amber-500" />
                                            </div>
                                            <h4 className="text-amber-500 text-[10px] font-black uppercase tracking-[0.2em] mb-6 flex items-center gap-3">
                                                <Activity size={16} /> AI Summary
                                            </h4>
                                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 relative z-10">
                                                {selectedRecord.summary.split('\n').filter(s => s.trim().length > 5).map((point, i) => (
                                                    <div key={i} className="flex gap-4 group/point">
                                                        <div className="shrink-0 w-6 h-6 rounded-full bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-500 font-bold text-[10px]">
                                                            {i + 1}
                                                        </div>
                                                        <p className="text-sm text-(--text-secondary) leading-relaxed group-hover/point:text-(--text-primary) transition-colors">{point.replace(/^[*-]\s*|^\d+\.\s*/, '')}</p>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    {/* Interactive Text */}
                                    <div className={`prose prose-invert max-w-none transition-all duration-500 ${isTranslating ? 'opacity-30 blur-sm scale-[0.99]' : 'opacity-100 blur-0 scale-100'}`}>
                                        {(() => {
                                            let segs = selectedRecord.segments;
                                            if (typeof segs === 'string') {
                                                try { segs = JSON.parse(segs); } catch { segs = []; }
                                            }
                                            
                                            if (activeView === 'original' && segs && segs.length > 0) {
                                                return (
                                                    <div className="flex flex-col h-[700px]">
                                                        <div className="flex items-center gap-2 mb-6 p-3 bg-purple-500/5 border border-purple-500/10 rounded-2xl w-fit mx-auto sticky top-0 z-20 backdrop-blur-sm">
                                                            <div className="w-1.5 h-1.5 rounded-full bg-purple-500 animate-pulse"></div>
                                                            <span className="text-[9px] font-black text-purple-400/80 uppercase tracking-widest">Enhanced Virtualization • {segs.length} segments • Click to jump</span>
                                                        </div>
                                                        
                                                        <Virtuoso
                                                            ref={virtuosoRef}
                                                            data={segs}
                                                            useWindowScroll={false}
                                                            increaseViewportBy={400}
                                                            itemContent={(index, seg: any) => {
                                                                const isCurrentActive = index === activeIndex;
                                                                return (
                                                                    <div className="pb-4 px-4">
                                                                        <div 
                                                                            onClick={() => seekAudio(seg.start)}
                                                                            className={`group/seg cursor-pointer p-6 rounded-3xl transition-all border-2 ${
                                                                                isCurrentActive 
                                                                                ? 'bg-purple-500/10 border-purple-500/40 shadow-xl' 
                                                                                : 'border-transparent hover:bg-purple-500/5 hover:border-(--border-subtle)'
                                                                            }`}
                                                                            dir={textAlign === 'auto' ? (selectedRecord.original_language === 'Arabic' ? 'rtl' : 'ltr') : textAlign}
                                                                        >
                                                                            <div className="flex items-center gap-4 mb-3" dir="ltr">
                                                                                <div className={`px-2 py-0.5 rounded text-[9px] font-black transition-all ${isCurrentActive ? 'bg-purple-500 text-white' : 'bg-(--bg-main) text-purple-400/60'}`}>
                                                                                    {formatDuration(seg.start)}
                                                                                </div>
                                                                                <span className="text-[10px] font-black text-(--text-muted) uppercase tracking-widest">
                                                                                    {seg.speaker}
                                                                                </span>
                                                                            </div>
                                                                            <p className={`leading-[1.8] text-[15px] transition-all ${isCurrentActive ? 'text-(--text-primary) font-semibold' : 'text-(--text-secondary) group-hover/seg:text-(--text-primary)'}`}>
                                                                                {seg.text}
                                                                            </p>
                                                                        </div>
                                                                    </div>
                                                                );
                                                            }}
                                                        />
                                                    </div>
                                                );
                                            }
                                            
                                            return (activeView === 'original' ? selectedRecord.transcription_text : selectedRecord.translations?.[activeView]?.text)?.split('\n').filter(p => p.trim()).map((para: string, i: number) => (
                                                <div key={i} className="mb-8 p-8 hover:bg-white/5 rounded-[2.5rem] transition-colors border border-transparent hover:border-(--border-subtle)/30">
                                                    <p dir={textAlign === 'auto' ? (activeView === 'Arabic' || (activeView === 'original' && selectedRecord.original_language === 'Arabic') ? 'rtl' : 'ltr') : textAlign} className={`text-(--text-secondary) leading-loose text-[16px] ${activeView === 'Arabic' || selectedRecord.original_language === 'Arabic' ? 'font-arabic text-2xl' : ''}`}>
                                                        {highlightSpeakers(para)}
                                                    </p>
                                                </div>
                                            ));
                                        })()}
                                    </div>

                                    {/* Footer Spacer */}
                                    <div className="h-20" />
                                </div>
                            ) : (
                                <div className="flex flex-col items-center justify-center h-full py-20 text-center px-10">
                                    {selectedRecord.status === 'failed' ? (
                                        <div className="bg-red-500/5 border border-red-500/10 p-12 rounded-[3rem] max-w-md w-full">
                                            <div className="w-20 h-20 rounded-3xl bg-red-500/10 flex items-center justify-center text-red-500 mx-auto mb-6">
                                                <AlertCircle size={40} />
                                            </div>
                                            <h4 className="text-2xl font-black text-red-400">Processing Failed</h4>
                                            <p className="text-(--text-muted) mt-4 text-sm leading-relaxed">{selectedRecord.error_message}</p>
                                            <button 
                                                onClick={fetchHistory}
                                                className="mt-8 px-6 py-3 bg-red-500/10 text-red-400 rounded-2xl text-xs font-black uppercase tracking-widest hover:bg-red-500/20 transition-all border border-red-500/20"
                                            >
                                                Try Refreshing
                                            </button>
                                        </div>
                                    ) : (
                                        <div className="flex flex-col items-center">
                                            <div className="relative mb-10 scale-150">
                                                <div className="absolute inset-0 bg-amber-500/20 rounded-full blur-2xl animate-pulse"></div>
                                                <RefreshCw size={56} className="text-amber-500 animate-spin relative z-10 stroke-1" />
                                            </div>
                                            <h4 className="text-2xl font-black text-amber-500 uppercase tracking-widest">In Progress</h4>
                                            <p className="text-(--text-muted) mt-4 max-w-xs text-sm">Our AI is analyzing every layer of your media. This takes just a moment...</p>
                                            <div className="mt-10 flex gap-2">
                                                {[...Array(3)].map((_, i) => (
                                                    <div key={i} className="w-2 h-2 rounded-full bg-amber-500/30 animate-bounce" style={{ animationDelay: `${i * 0.2}s` }} />
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    </>
                ) : (
                    <div className="flex-1 flex flex-col items-center justify-center text-center p-20 bg-[radial-gradient(circle_at_center,rgba(168,85,247,0.03),transparent_70%)] relative">
                        <div className="absolute inset-0 opacity-10 pointer-events-none overflow-hidden">
                             <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-purple-500/20 rounded-full blur-[120px] animate-pulse"></div>
                        </div>
                        <div className="w-24 h-24 rounded-[2.5rem] bg-(--card-bg) border border-(--border-subtle) flex items-center justify-center mb-8 shadow-[0_20px_50px_rgba(0,0,0,0.3)] ring-1 ring-white/5 relative z-10 transition-transform hover:scale-105 duration-500">
                            <FileText size={40} className="text-purple-400 stroke-1" />
                        </div>
                        <h3 className="text-3xl font-black text-(--text-primary) mb-4 uppercase tracking-[0.2em] relative z-10">Select a transcription</h3>
                        <p className="text-(--text-muted) max-w-sm text-[15px] leading-relaxed relative z-10 opacity-70">
                            Explore your processed media history. Select a record from the sidebar to unlock AI insights, summaries, and multilingual translations.
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
};

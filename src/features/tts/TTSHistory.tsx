import React, { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { Clock, PlayCircle, Trash2, Volume2, RefreshCw, AlertCircle, FileText } from 'lucide-react';

interface TTSRecord {
    id: string;
    title: string;
    text_content: string;
    voice_model: string;
    storage_path: string;
    duration_ms: number;
    status: string;
    created_at: string;
}

interface TTSHistoryProps {
    userId: string;
}

export const TTSHistory = ({ userId: _userId }: TTSHistoryProps) => {
    const [records, setRecords] = useState<TTSRecord[]>([]);
    const [loading, setLoading] = useState(true);
    const [selectedRecord, setSelectedRecord] = useState<TTSRecord | null>(null);

    const fetchHistory = async () => {
        setLoading(true);
        try {
            const { data, error } = await supabase
                .from('tts_history')
                .select('*')
                .order('created_at', { ascending: false });

            if (error) throw error;
            setRecords(data || []);
        } catch (err) {
            console.error("[TTS] Error fetching history:", err);
        } finally {
            setLoading(false);
        }
    };

    const handleDelete = async (e: React.MouseEvent, record: TTSRecord) => {
        e.stopPropagation();
        if (!confirm('Are you sure you want to delete this audio generation?')) return;

        try {
            if (record.storage_path) {
                await supabase.storage.from('tts_audio_assets').remove([record.storage_path]);
            }

            const { error } = await supabase
                .from('tts_history')
                .delete()
                .eq('id', record.id);

            if (error) throw error;

            setRecords(prev => prev.filter(r => r.id !== record.id));
            if (selectedRecord?.id === record.id) setSelectedRecord(null);
        } catch (err) {
            console.error("[TTS] Error deleting record:", err);
            alert("Failed to delete record.");
        }
    };

    useEffect(() => {
        fetchHistory();
        
        // Subscription for real-time updates
        const channel = supabase
            .channel('tts-changes')
            .on(
                'postgres_changes',
                { event: '*', schema: 'public', table: 'tts_history' },
                () => {
                    fetchHistory();
                }
            )
            .subscribe();

        return () => {
            supabase.removeChannel(channel);
        };
    }, []);

    // Helper to format model names cleanly
    const formatVoiceName = (id: string) => {
        return id;
    };

    if (loading && records.length === 0) {
        return (
            <div className="w-full flex justify-center py-20">
                <RefreshCw size={32} className="text-indigo-500 animate-spin" />
            </div>
        );
    }

    if (records.length === 0) {
        return (
            <div className="w-full max-w-4xl mx-auto p-4 sm:p-6 lg:p-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
                <div className="text-center py-20 bg-(--bg-main) border border-(--border-subtle) rounded-2xl shadow-sm">
                    <Volume2 size={48} className="mx-auto text-indigo-500/30 mb-4" />
                    <h3 className="text-xl font-bold text-(--text-primary) mb-2">No audio generated yet</h3>
                    <p className="text-(--text-muted)">Generate some audio from text to see your history here.</p>
                </div>
            </div>
        );
    }

    return (
        <div className="w-full max-w-4xl mx-auto p-4 sm:p-6 lg:p-8 flex flex-col md:flex-row gap-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
            {/* List Column */}
            <div className="md:w-1/3 flex flex-col gap-4">
                <div className="flex items-center justify-between mb-2">
                    <h2 className="text-lg font-black tracking-wide text-(--text-primary)">Library <span className="text-indigo-500 font-normal">({records.length})</span></h2>
                    <button onClick={fetchHistory} className="p-2 bg-indigo-500/10 text-indigo-400 hover:bg-indigo-500/20 rounded-lg transition-colors" title="Refresh">
                        <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
                    </button>
                </div>

                <div className="flex flex-col gap-3 max-h-[70vh] overflow-y-auto px-1 -mx-1 custom-scrollbar">
                    {records.map(record => (
                        <div 
                            key={record.id}
                            onClick={() => setSelectedRecord(record)}
                            className={`group relative overflow-hidden custom-card p-4 transition-all cursor-pointer ${
                                selectedRecord?.id === record.id 
                                ? 'bg-indigo-500/10 border-indigo-500/40 shadow-[0_0_15px_rgba(99,102,241,0.15)] ring-1 ring-indigo-500/20' 
                                : 'hover:bg-[rgba(99,102,241,0.02)] hover:border-[rgba(99,102,241,0.2)] hover:shadow-lg hover:-translate-y-0.5'
                            }`}
                        >
                            <div className="absolute top-0 left-0 w-1 h-full bg-linear-to-b from-blue-400 to-indigo-500 opacity-50 transform -translate-x-full group-hover:translate-x-0 transition-transform"></div>
                            
                            <div className="flex justify-between items-start mb-2">
                                <h3 className="font-bold text-(--text-primary) text-sm truncate pr-6 leading-tight">
                                    {record.title}
                                </h3>
                                <button 
                                    onClick={(e) => handleDelete(e, record)}
                                    className="text-red-400/50 hover:text-red-400 transition-colors p-1 -mr-1 rounded-md opacity-0 group-hover:opacity-100 bg-red-400/10"
                                    title="Delete Audio"
                                >
                                    <Trash2 size={12} />
                                </button>
                            </div>
                            
                            <div className="flex items-center gap-3 text-[10px] font-bold uppercase tracking-widest text-(--text-muted) mb-3">
                                <div className="flex items-center gap-1.5 text-indigo-400">
                                    <Volume2 size={12} />
                                    <span>{formatVoiceName(record.voice_model)}</span>
                                </div>
                                <div className="w-1 h-1 rounded-full bg-(--border-subtle)"></div>
                                <div className="flex items-center gap-1.5">
                                    <Clock size={12} />
                                    <span>{new Date(record.created_at).toLocaleDateString()}</span>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {/* Details Column */}
            <div className="md:w-2/3">
                {selectedRecord ? (
                    <div className="custom-card overflow-hidden sticky top-24 bg-(--bg-main) border-(--border-subtle)">
                        <div className="absolute top-0 right-0 w-96 h-96 bg-indigo-500/5 rounded-full blur-3xl -mr-48 -mt-48 pointer-events-none"></div>
                        
                        <div className="p-6 border-b border-(--border-subtle) flex items-center justify-between bg-(--bg-glass)">
                            <div>
                                <h2 className="text-xl font-black text-(--text-primary) mb-1">{selectedRecord.title}</h2>
                                <p className="text-xs text-(--text-muted) font-medium flex items-center gap-3">
                                    <span className="flex items-center gap-1 text-indigo-400 bg-indigo-400/10 px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-widest">
                                        <Volume2 size={12} /> {formatVoiceName(selectedRecord.voice_model)} Voice
                                    </span>
                                </p>
                            </div>
                        </div>
                        
                        <div className="p-6">
                            {selectedRecord.status === 'completed' ? (
                                <div className="space-y-8">
                                    {/* Audio Player */}
                                    <div className={`bg-(--bg-main) border border-(--border-subtle) rounded-2xl p-4 flex items-center gap-6 shadow-sm`}>
                                        <div className="w-10 h-10 rounded-full bg-indigo-500/10 flex items-center justify-center text-indigo-400">
                                            <PlayCircle size={20} />
                                        </div>
                                        <div className="flex-1">
                                            <p className="text-[10px] font-black uppercase tracking-widest text-(--text-muted) mb-2">Generated Speech Playback</p>
                                            <audio 
                                                src={supabase.storage.from('tts_audio_assets').getPublicUrl(selectedRecord.storage_path).data.publicUrl} 
                                                controls 
                                                crossOrigin="anonymous"
                                                className="w-full h-10 accent-indigo-500"
                                            />
                                        </div>
                                    </div>

                                    {/* Source Text */}
                                    <div>
                                        <div className="flex items-center justify-between mb-4">
                                            <div className="flex items-center gap-2 text-indigo-400">
                                                <FileText size={14} />
                                                <span className="text-[10px] font-bold uppercase tracking-wider">Source Text</span>
                                            </div>
                                        </div>
                                        <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-5 custom-scrollbar max-h-96 overflow-y-auto">
                                            <p className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap" dir="auto">
                                                {selectedRecord.text_content}
                                            </p>
                                        </div>
                                    </div>
                                </div>
                            ) : selectedRecord.status === 'failed' ? (
                                <div className="flex flex-col items-center justify-center py-12 text-center">
                                    <AlertCircle size={48} className="text-red-400 mb-4" />
                                    <h4 className="text-lg font-bold text-red-400 mb-2">Generation Failed</h4>
                                    <p className="text-(--text-muted) max-w-md">An error occurred while generating this audio.</p>
                                </div>
                            ) : (
                                <div className="flex flex-col items-center justify-center py-20 text-center">
                                    <RefreshCw size={48} className="text-indigo-400 animate-spin mb-4" />
                                    <h4 className="text-lg font-bold text-indigo-400 mb-2">Generating Audio</h4>
                                    <p className="text-(--text-muted)">ElevenLabs is currently synthesizing your voice track...</p>
                                </div>
                            )}
                        </div>

                        <div className="p-6 border-t border-(--border-subtle) bg-(--bg-glass) flex items-center justify-between">
                            <div className="flex gap-6">
                                <div className="flex flex-col">
                                    <span className="text-[10px] text-(--text-muted) uppercase font-black tracking-widest">Processing Time</span>
                                    <span className="text-sm font-bold truncate max-w-[120px]">
                                        {selectedRecord.duration_ms ? `${(selectedRecord.duration_ms / 1000).toFixed(2)}s` : 'Unknown'}
                                    </span>
                                </div>
                            </div>
                            
                            <div className="flex flex-wrap gap-3">
                                <button 
                                    onClick={() => {
                                        const url = supabase.storage.from('tts_audio_assets').getPublicUrl(selectedRecord.storage_path).data.publicUrl;
                                        const a = document.createElement('a');
                                        a.href = url;
                                        a.download = `${selectedRecord.title.substring(0,20)}_tts.mp3`;
                                        a.click();
                                    }}
                                    disabled={selectedRecord.status !== 'completed'}
                                    className="btn-primary bg-indigo-500 hover:bg-indigo-400 px-5 py-2 text-xs font-bold flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    <Volume2 size={14} />
                                    Audio (.mp3)
                                </button>
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="h-full flex items-center justify-center border-2 border-dashed border-(--border-subtle) rounded-3xl p-12 custom-card relative overflow-hidden">
                        <div className="text-center z-10 relative">
                            <div className="w-20 h-20 rounded-full bg-indigo-500/5 flex items-center justify-center mx-auto mb-6 shadow-inner ring-1 ring-indigo-500/10">
                                <Volume2 size={32} className="text-indigo-500/30" />
                            </div>
                            <h3 className="text-xl font-black text-(--text-primary) mb-3">Select Audio</h3>
                            <p className="text-sm text-(--text-muted) max-w-sm mx-auto leading-relaxed">
                                Choose a generated track from your library to listen, read along, and download the MP3 file.
                            </p>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

import { useState } from 'react';
import { DocumentConverter } from './features/converter/DocumentConverter';
import { MediaTranscriber } from './features/transcriber/MediaTranscriber';
import { TranscriptionHistory } from './features/transcriber/TranscriptionHistory';
import { Layout, History, Video } from 'lucide-react';

function App() {
  const [activeTab, setActiveTab] = useState<'document' | 'media' | 'history'>('document');
  const [userId] = useState('00000000-0000-0000-0000-000000000000'); // Valid UUID placeholder for guest/local user

  return (
    <div className="min-h-screen bg-(--bg-main) text-(--text-primary)">
      <nav className="bg-(--nav-bg) border-b border-(--border-subtle) p-4 flex gap-4 justify-center sticky top-0 z-50 backdrop-blur-md bg-opacity-80">
        <button 
          onClick={() => setActiveTab('document')}
          className={`px-6 py-2 rounded-xl font-bold transition-all flex items-center gap-2 ${activeTab === 'document' ? 'bg-indigo-500/20 text-indigo-400 shadow-[0_0_15px_rgba(99,102,241,0.15)]' : 'text-(--text-muted) hover:text-(--text-primary)'}`}
        >
          <Layout size={18} />
          PDF to Word
        </button>
        <button 
          onClick={() => setActiveTab('media')}
          className={`px-6 py-2 rounded-xl font-bold transition-all flex items-center gap-2 ${activeTab === 'media' ? 'bg-purple-500/20 text-purple-400 shadow-[0_0_15px_rgba(168,85,247,0.15)]' : 'text-(--text-muted) hover:text-(--text-primary)'}`}
        >
          <Video size={18} />
          Media Transcriber
        </button>
        <button 
          onClick={() => setActiveTab('history')}
          className={`px-6 py-2 rounded-xl font-bold transition-all flex items-center gap-2 ${activeTab === 'history' ? 'bg-emerald-500/20 text-emerald-400 shadow-[0_0_15px_rgba(16,185,129,0.15)]' : 'text-(--text-muted) hover:text-(--text-primary)'}`}
        >
          <History size={18} />
          History
        </button>
      </nav>

      <main className="max-w-7xl mx-auto">
        {activeTab === 'document' && <DocumentConverter userId={userId} />}
        {activeTab === 'media' && <MediaTranscriber userId={userId} />}
        {activeTab === 'history' && <TranscriptionHistory userId={userId} />}
      </main>
    </div>
  );
}

export default App;

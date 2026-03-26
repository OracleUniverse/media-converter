-- 1. Create Storage Bucket for TTS Audio
INSERT INTO storage.buckets (id, name, public) 
VALUES ('tts_audio_assets', 'tts_audio_assets', true)
ON CONFLICT (id) DO NOTHING;

-- 2. Storage Policies for tts_audio_assets
DROP POLICY IF EXISTS "Public can view TTS audio assets" ON storage.objects;
CREATE POLICY "Public can view TTS audio assets"
ON storage.objects FOR SELECT
TO public
USING (bucket_id = 'tts_audio_assets');

DROP POLICY IF EXISTS "Users can upload TTS audio assets" ON storage.objects;
CREATE POLICY "Users can upload TTS audio assets"
ON storage.objects FOR INSERT
TO public
WITH CHECK (
    bucket_id = 'tts_audio_assets' 
    AND (auth.uid()::text = (storage.foldername(name))[1] OR (storage.foldername(name))[1] = '00000000-0000-0000-0000-000000000000')
);

DROP POLICY IF EXISTS "Users can delete their own TTS audio assets" ON storage.objects;
CREATE POLICY "Users can delete their own TTS audio assets"
ON storage.objects FOR DELETE
TO public
USING (
    bucket_id = 'tts_audio_assets' 
    AND (auth.uid()::text = (storage.foldername(name))[1] OR (storage.foldername(name))[1] = '00000000-0000-0000-0000-000000000000')
);

-- 3. Create TTS History Table
CREATE TABLE IF NOT EXISTS public.tts_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID DEFAULT auth.uid(), -- Link to auth.users
    title TEXT NOT NULL,
    text_content TEXT NOT NULL,
    voice_model TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    duration_ms INTEGER,
    status TEXT DEFAULT 'completed', -- 'processing', 'completed', 'failed'
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Enable RLS
ALTER TABLE public.tts_history ENABLE ROW LEVEL SECURITY;

-- 5. Policies
DROP POLICY IF EXISTS "Users can insert their own tts history" ON public.tts_history;
CREATE POLICY "Users can insert their own tts history" 
ON public.tts_history FOR INSERT 
WITH CHECK (auth.uid() = user_id OR user_id = '00000000-0000-0000-0000-000000000000');

DROP POLICY IF EXISTS "Users can view their own tts history" ON public.tts_history;
CREATE POLICY "Users can view their own tts history" 
ON public.tts_history FOR SELECT 
USING (auth.uid() = user_id OR user_id = '00000000-0000-0000-0000-000000000000');

DROP POLICY IF EXISTS "Users can update their own tts history" ON public.tts_history;
CREATE POLICY "Users can update their own tts history" 
ON public.tts_history FOR UPDATE 
USING (auth.uid() = user_id OR user_id = '00000000-0000-0000-0000-000000000000');

DROP POLICY IF EXISTS "Users can delete their own tts history" ON public.tts_history;
CREATE POLICY "Users can delete their own tts history" 
ON public.tts_history FOR DELETE 
USING (auth.uid() = user_id OR user_id = '00000000-0000-0000-0000-000000000000');

-- 6. Trigger for updated_at
DROP TRIGGER IF EXISTS update_tts_history_updated_at ON public.tts_history;
CREATE TRIGGER update_tts_history_updated_at
BEFORE UPDATE ON public.tts_history
FOR EACH ROW
EXECUTE PROCEDURE update_updated_at_column();

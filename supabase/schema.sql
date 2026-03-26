INSERT INTO storage.buckets (id, name, public) 
VALUES ('trans_media_assets', 'trans_media_assets', false)
ON CONFLICT (id) DO NOTHING;

-- Storage Policies for trans_media_assets
-- Allow users (authenticated or guest with special ID) to upload
DROP POLICY IF EXISTS "Users can upload media assets" ON storage.objects;
CREATE POLICY "Users can upload media assets"
ON storage.objects FOR INSERT
TO public
WITH CHECK (
    bucket_id = 'trans_media_assets' 
    AND (auth.uid()::text = (storage.foldername(name))[1] OR (storage.foldername(name))[1] = '00000000-0000-0000-0000-000000000000')
);

-- Allow users to view their own media assets
DROP POLICY IF EXISTS "Users can view their own media assets" ON storage.objects;
CREATE POLICY "Users can view their own media assets"
ON storage.objects FOR SELECT
TO public
USING (
    bucket_id = 'trans_media_assets' 
    AND (auth.uid()::text = (storage.foldername(name))[1] OR (storage.foldername(name))[1] = '00000000-0000-0000-0000-000000000000')
);

-- Allow users to delete their own media assets
DROP POLICY IF EXISTS "Users can delete their own media assets" ON storage.objects;
CREATE POLICY "Users can delete their own media assets"
ON storage.objects FOR DELETE
TO public
USING (
    bucket_id = 'trans_media_assets' 
    AND (auth.uid()::text = (storage.foldername(name))[1] OR (storage.foldername(name))[1] = '00000000-0000-0000-0000-000000000000')
);

-- 2. Create Media Transcriptions Table
CREATE TABLE IF NOT EXISTS public.trans_media_transcriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID DEFAULT auth.uid(), -- Link to auth.users
    original_filename TEXT NOT NULL,
    file_size BIGINT, -- In bytes
    duration FLOAT, -- In seconds
    model_id TEXT, -- e.g. 'google/gemini-2.0-flash-001'
    transcription_text TEXT,
    chunk_index INTEGER DEFAULT 1,
    total_chunks INTEGER DEFAULT 1,
    processing_time_ms INTEGER,
    status TEXT DEFAULT 'pending', -- 'pending', 'processing', 'completed', 'failed'
    storage_path TEXT, -- Path to the audio file in the bucket
    original_language TEXT, -- e.g. 'English', 'Arabic', 'Mixed'
    transcription_metadata JSONB DEFAULT '{}'::jsonb, -- Store logs for transcription
    translations JSONB DEFAULT '{}'::jsonb, -- Store multiple translations { "Arabic": { "text": "...", "metadata": {...} } }
    summary TEXT, -- AI generated summary
    segments JSONB DEFAULT '[]'::jsonb, -- Timestamped segments for SRT [{ "start": 0, "end": 5, "text": "...", "speaker": "Speaker 1" }]
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Enable RLS
ALTER TABLE public.trans_media_transcriptions ENABLE ROW LEVEL SECURITY;

-- 4. Policies (Simple: Users can read/write their own records)
DROP POLICY IF EXISTS "Users can insert their own transcriptions" ON public.trans_media_transcriptions;
CREATE POLICY "Users can insert their own transcriptions" 
ON public.trans_media_transcriptions FOR INSERT 
WITH CHECK (auth.uid() = user_id OR user_id = '00000000-0000-0000-0000-000000000000');

DROP POLICY IF EXISTS "Users can view their own transcriptions" ON public.trans_media_transcriptions;
CREATE POLICY "Users can view their own transcriptions" 
ON public.trans_media_transcriptions FOR SELECT 
USING (auth.uid() = user_id OR user_id = '00000000-0000-0000-0000-000000000000');

DROP POLICY IF EXISTS "Users can update their own transcriptions" ON public.trans_media_transcriptions;
CREATE POLICY "Users can update their own transcriptions" 
ON public.trans_media_transcriptions FOR UPDATE 
USING (auth.uid() = user_id OR user_id = '00000000-0000-0000-0000-000000000000');

DROP POLICY IF EXISTS "Users can delete their own transcriptions" ON public.trans_media_transcriptions;
CREATE POLICY "Users can delete their own transcriptions" 
ON public.trans_media_transcriptions FOR DELETE 
USING (auth.uid() = user_id OR user_id = '00000000-0000-0000-0000-000000000000');

-- 5. Helper function for updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_trans_media_transcriptions_updated_at ON public.trans_media_transcriptions;
CREATE TRIGGER update_trans_media_transcriptions_updated_at
BEFORE UPDATE ON public.trans_media_transcriptions
FOR EACH ROW
EXECUTE PROCEDURE update_updated_at_column();

-- 6. Support for older tables (Migration helper)
ALTER TABLE public.trans_media_transcriptions ADD COLUMN IF NOT EXISTS original_language TEXT;
ALTER TABLE public.trans_media_transcriptions ADD COLUMN IF NOT EXISTS transcription_metadata JSONB DEFAULT '{}'::jsonb;
ALTER TABLE public.trans_media_transcriptions ADD COLUMN IF NOT EXISTS translations JSONB DEFAULT '{}'::jsonb;
ALTER TABLE public.trans_media_transcriptions ADD COLUMN IF NOT EXISTS summary TEXT;
ALTER TABLE public.trans_media_transcriptions ADD COLUMN IF NOT EXISTS segments JSONB DEFAULT '[]'::jsonb;

-- Migration to cleanup old columns (optional but recommended)
-- ALTER TABLE public.trans_media_transcriptions DROP COLUMN IF EXISTS translated_text;
-- ALTER TABLE public.trans_media_transcriptions DROP COLUMN IF EXISTS translated_language;
-- ALTER TABLE public.trans_media_transcriptions DROP COLUMN IF EXISTS translation_metadata;

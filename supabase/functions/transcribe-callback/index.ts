import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

console.log("🚀 Edge Function: transcribe-callback starting...")

serve(async (req: any) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // 1. Extract Record ID from Query Params
    const url = new URL(req.url);
    const recordId = url.searchParams.get('recordId');
    console.log(`[CALLBACK] 📩 Received callback for record: ${recordId}`);

    if (!recordId) throw new Error("Missing recordId in callback URL");

    // 2. Initialize Supabase Admin (for internal DB updates)
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { persistSession: false } }
    )

    // 3. Parse Deepgram Payload
    const dgData = await req.json();
    console.log(`[CALLBACK] 📦 Deepgram Request ID: ${dgData.request_id}`);

    if (dgData.error) {
       console.error(`[CALLBACK] ❌ Deepgram Reported Error: ${dgData.error}`);
       await supabaseAdmin.from('trans_media_transcriptions').update({ status: 'failed', error_message: dgData.error }).eq('id', recordId);
       return new Response('error-logged', { status: 200 });
    }

    // 4. Word-First Segmentation Algorithm (CRITICAL: Strict Speaker Isolation)
    console.log(`[CALLBACK] 📋 Processing ${words.length} words with Nova-2 diarization...`);
    const detectedLang = dgData.results?.channels?.[0]?.detected_language || 'mixed';
    
    const segments: any[] = [];
    if (words.length > 0) {
      // Robust initialization
      let currentSpeaker = words[0].speaker ?? 0;
      let segmentStartTime = words[0].start;
      let currentSegmentWords: any[] = [];

      const finalizeSegment = () => {
        if (currentSegmentWords.length === 0) return;
        segments.push({
          start: segmentStartTime,
          end: currentSegmentWords[currentSegmentWords.length - 1].end,
          speaker: `Speaker ${currentSpeaker + 1}`,
          text: currentSegmentWords.map(w => w.punctuated_word || w.word).join(' ')
        });
        currentSegmentWords = [];
      };

      for (let i = 0; i < words.length; i++) {
        const word = words[i];
        const wordSpeaker = word.speaker ?? 0;
        
        // --- TRIGGER 1: Speaker Switch (Instant Split) ---
        // If this word belongs to a different speaker than the current segment
        if (i > 0 && wordSpeaker !== currentSpeaker) {
          finalizeSegment(); // Close previous speaker's segment
          currentSpeaker = wordSpeaker;
          segmentStartTime = word.start;
        }

        currentSegmentWords.push(word);

        // --- TRIGGER 2: Max Duration (15s) at Sentence Boundary ---
        const duration = word.end - segmentStartTime;
        const isSentenceEnd = /[.!?]/.test(word.punctuated_word || word.word);
        
        if (duration > 15 && isSentenceEnd) {
          finalizeSegment();
          // Prime next segment with the next word's info if available
          if (i + 1 < words.length) {
            currentSpeaker = words[i + 1].speaker ?? 0;
            segmentStartTime = words[i + 1].start;
          }
        }
      }
      finalizeSegment(); // Finalize last segment
    }

    console.log(`[CALLBACK] ✅ Generated ${segments.length} isolated segments.`);
    const fullText = segments.map(s => `${s.speaker}: ${s.text}`).join('\n\n');

    // 5. Update Database
    console.log(`[CALLBACK] 💾 Saving results to DB...`);
    const { error: updateError } = await supabaseAdmin
      .from('trans_media_transcriptions')
      .update({
        transcription_text: fullText,
        original_language: detectedLang === 'ar' ? 'Arabic' : (detectedLang === 'en' ? 'English' : 'Mixed'),
        model_id: 'deepgram-nova-2',
        status: 'completed',
        segments: segments,
        transcription_metadata: {
            request_id: dgData.request_id,
            model: 'nova-2',
            callback_processed_at: new Date().toISOString()
        }
      })
      .eq('id', recordId);

    if (updateError) {
      console.error("[CALLBACK] ❌ DB Update Error:", updateError.message);
      throw updateError;
    }

    // 6. Optional: Trigger Summarization
    console.log(`[CALLBACK] 🤖 Triggering auto-summary...`);
    try {
        const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
        const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
        await fetch(`${SUPABASE_URL}/functions/v1/summarize-text`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
            },
            body: JSON.stringify({ text: fullText, recordId })
        });
    } catch (sumErr) {
        console.warn("[CALLBACK] ⚠️ Auto-summary trigger failed (non-blocking):", sumErr);
    }

    console.log(`[CALLBACK] ✅ Professional Callback Finished.`);
    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err: any) {
    console.error(`[CALLBACK FATAL] ❌ ${err.message}`);
    return new Response(JSON.stringify({ error: err.message }), { 
      status: 500, 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    });
  }
});

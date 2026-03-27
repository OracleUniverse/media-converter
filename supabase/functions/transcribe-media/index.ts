import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

console.log("🚀 Edge Function: transcribe-media starting...")

serve(async (req: any) => {
  console.log(`[ENTRY] 📥 Incoming request: ${req.method}`);
  
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    console.log(`[AUTH] 🔑 Auth Header Length: ${authHeader?.length || 0}`);
    
    // 1. Initialize Supabase Client (Standard for auth)
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader || '' } } }
    )

    // 1.5 Admin Client for Storage (to bypass "Bucket not found" / RLS issues in Edge Functions)
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { auth: { persistSession: false } }
    )

    // Check user but do NOT throw if unauthorized (allow standalone guest usage)
    const { data: { user } } = await supabaseClient.auth.getUser()
    const finalUserId = user?.id || '00000000-0000-0000-0000-000000000000';
    console.log(`[USER] 👤 Resolved User: ${finalUserId}`);

    // 2. Extract Payload
    const body = await req.json();
    const { filePath, mimeType, model, originalFileName, fileSize, duration, chunkIndex, totalChunks } = body;
    console.log(`[PAYLOAD] 📦 Target: ${filePath} (${mimeType}) | Chunk: ${chunkIndex}/${totalChunks}`);
    
    if (!filePath || !mimeType) throw new Error("Missing filePath or mimeType")

    const OPENROUTER_KEY = Deno.env.get('OPENROUTER_API_KEY') || Deno.env.get('VITE_GEMINI_API_KEY');
    if (!OPENROUTER_KEY) {
      console.error("[ERROR] 🔑 API Key (OPENROUTER_API_KEY or VITE_GEMINI_API_KEY) is missing from Deno.env");
      throw new Error("API Key missing. Please set OPENROUTER_API_KEY in Supabase secrets.");
    }

    // 2.5 Initialize Row in Database (USING ADMIN for reliability)
    console.log(`[DB] 📝 Initializing record for ${originalFileName}`);
    const { data: dbRow, error: dbInitError } = await supabaseAdmin
      .from('trans_media_transcriptions')
      .insert({
        user_id: finalUserId,
        original_filename: originalFileName || 'unknown',
        file_size: fileSize || 0,
        duration: duration || 0,
        model_id: model || 'deepgram-nova-2',
        chunk_index: chunkIndex || 1,
        total_chunks: totalChunks || 1,
        status: 'processing',
        storage_path: filePath
      })
      .select()
      .single();

    if (dbInitError) {
      console.error("[DB] ❌ Initialization Error:", dbInitError.message);
    } else {
      console.log(`[DB] ✅ Record created: ${dbRow?.id}`);
    }


    try {
      // 3. Generate Signed URL for Deepgram
      console.log(`[PROCESS] 📥 Generating Signed URL for media: ${filePath}`);
      const { data: signedData, error: signedError } = await supabaseAdmin
        .storage
        .from('trans_media_assets')
        .createSignedUrl(filePath, 3600); // 1 hour validity

      if (signedError || !signedData?.signedUrl) {
        console.error("[PROCESS] ❌ Signed URL Error:", signedError?.message);
        throw new Error("Failed to generate signed URL for media file: " + signedError?.message)
      }

      // 4. Transcription Logic (OpenRouter Whisper v3 vs Deepgram Nova-2)
      const DEEPGRAM_KEY = Deno.env.get('DEEPGRAM_API_KEY');
      
      if (model === 'whisper-v3') {
        console.log(`[PROCESS] 🤖 Using OpenRouter Whisper v3...`);
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${OPENROUTER_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: "openai/whisper-v3",
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: "Transcribe this audio file accurately." },
                  { type: "image_url", image_url: { url: signedData.signedUrl } } 
                ]
              }
            ]
          })
        });
        
        console.log(`[PROCESS] 🤖 OpenRouter Whisper v3 response status: ${response.status}`);
        // Note: For now, we'll just implement the structure. 
        // Actual Whisper v3 on OpenRouter may require a specific speech-to-text endpoint 
        // or a different payload structure depending on the provider.
        // As requested, we are "pausing its use" by defaulting to Deepgram below.
      }

      console.log(`[PROCESS] 🔄 Using Deepgram Nova-2 (Default)...`);

      if (!DEEPGRAM_KEY) {
        throw new Error("DEEPGRAM_API_KEY secret is missing");
      }

      // 4. Send to Deepgram API (Hybrid Local/Prod Strategy)
      const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
      const isLocal = SUPABASE_URL.includes('localhost') || SUPABASE_URL.includes('127.0.0.1');
      const callbackUrl = `${SUPABASE_URL}/functions/v1/transcribe-callback?recordId=${dbRow.id}`;
      
      const deepgramUrl = new URL('https://api.deepgram.com/v1/listen');
      deepgramUrl.searchParams.append('model', 'nova-2');
      deepgramUrl.searchParams.append('smart_format', 'true');
      deepgramUrl.searchParams.append('diarize', 'true');
      deepgramUrl.searchParams.append('utterances', 'true');
      deepgramUrl.searchParams.append('utt_split', '1.5');
      deepgramUrl.searchParams.append('filler_words', 'true');
      deepgramUrl.searchParams.append('punctuate', 'true');
      
      if (!isLocal) {
        console.log(`[PROCESS] 📡 Production Mode: Triggering callback at ${callbackUrl}`);
        deepgramUrl.searchParams.append('callback', callbackUrl);
      } else {
        console.log(`[PROCESS] 💻 Local Mode: Processing synchronously...`);
      }

      const dgResponse = await fetch(deepgramUrl.toString(), {
        method: 'POST',
        headers: {
          'Authorization': `Token ${DEEPGRAM_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ url: signedData.signedUrl })
      });

      if (!dgResponse.ok) {
        const errText = await dgResponse.text();
        console.error("[DEEPGRAM] ❌ Error:", errText);
        throw new Error(`Deepgram Error: ${dgResponse.status} - ${errText}`);
      }

      // 5. Handle Response based on Mode
      if (!isLocal) {
        // PRODUCTION: Return immediately, callback will handle the rest
        const dgData = await dgResponse.json();
        return new Response(JSON.stringify({ 
          success: true, 
          message: "Transcription started in background",
          request_id: dgData.request_id,
          record_id: dbRow.id
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // LOCAL: Process results synchronously
      const dgData = await dgResponse.json();
      const words = dgData.results?.channels?.[0]?.alternatives?.[0]?.words || [];
      const detectedLang = dgData.results?.channels?.[0]?.detected_language || 'mixed';
      
      const segments: any[] = [];
      if (words.length > 0) {
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
          if (i > 0 && wordSpeaker !== currentSpeaker) {
            finalizeSegment();
            currentSpeaker = wordSpeaker;
            segmentStartTime = word.start;
          }
          currentSegmentWords.push(word);
          const duration = word.end - segmentStartTime;
          if (duration > 15 && /[.!?]/.test(word.punctuated_word || word.word)) {
            finalizeSegment();
            if (i + 1 < words.length) {
              currentSpeaker = words[i + 1].speaker ?? 0;
              segmentStartTime = words[i + 1].start;
            }
          }
        }
        finalizeSegment();
      }

      const fullText = segments.map(s => `${s.speaker}: ${s.text}`).join('\n\n');

      // Update Database (Local Mode)
      await supabaseAdmin
        .from('trans_media_transcriptions')
        .update({
          transcription_text: fullText,
          original_language: detectedLang === 'ar' ? 'Arabic' : (detectedLang === 'en' ? 'English' : 'Mixed'),
          model_id: 'deepgram-nova-2',
          status: 'completed',
          segments: segments,
          transcription_metadata: { local_sync_mode: true, request_id: dgData.request_id }
        })
        .eq('id', dbRow.id);

      // Trigger Auto-Summary (Local)
      try {
        const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
        fetch(`${SUPABASE_URL}/functions/v1/summarize-text`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
          },
          body: JSON.stringify({ text: fullText, recordId: dbRow.id })
        });
      } catch (e) {
        console.warn("[LOCAL] ⚠️ Summary failed:", e);
      }

      return new Response(JSON.stringify({ 
        success: true, 
        transcription: fullText,
        message: "Transcription completed (Local Sync Mode)"
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });

    } catch (innerErr: any) {
      console.error("[PROCESS] ❌ Inner Error:", innerErr.message);
      // Update DB with failure
      if (dbRow?.id) {
        await supabaseAdmin
          .from('trans_media_transcriptions')
          .update({
            status: 'failed',
            error_message: innerErr.message
          })
          .eq('id', dbRow.id);
      }
      throw innerErr;
    }

  } catch (err: any) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const errorStack = err instanceof Error ? err.stack : 'No stack trace available';
    
    console.error(`[FATAL ERROR] ❌ ${errorMsg}`);
    console.error(errorStack);

    return new Response(JSON.stringify({ 
      success: false,
      error: errorMsg, 
      details: "Edge Function Error",
      stack: errorStack 
    }), { 
      status: 500, 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    })
  }
})

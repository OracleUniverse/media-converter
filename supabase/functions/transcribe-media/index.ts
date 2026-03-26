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
        model_id: model || 'google/gemini-2.0-flash-001',
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

    const startTime = Date.now();

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

      console.log(`[PROCESS] 🔄 Passing Signed URL to Deepgram...`);

      const DEEPGRAM_KEY = Deno.env.get('DEEPGRAM_API_KEY');
      if (!DEEPGRAM_KEY) {
        throw new Error("DEEPGRAM_API_KEY secret is missing");
      }

      // 4. Send to Deepgram API
      const deepgramUrl = new URL('https://api.deepgram.com/v1/listen');
      deepgramUrl.searchParams.append('model', 'whisper-large');
      deepgramUrl.searchParams.append('utterances', 'true');
      deepgramUrl.searchParams.append('diarize', 'true');
      deepgramUrl.searchParams.append('detect_language', 'true');

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
        throw new Error(`Deepgram API Error: ${dgResponse.status} - ${errText}`);
      }

      const dgData = await dgResponse.json();
      const endTime = Date.now();
      const processingTime = endTime - startTime;
      console.log(`[PROCESS] ✨ Deepgram Finished in ${(processingTime / 1000).toFixed(1)}s`);

      // 5. Map Deepgram Response
      const detectedLang = dgData.results?.channels[0]?.detected_language || 'mixed';
      
      // Map utterances to our KaraokeSegment format
      const utterances = dgData.results?.utterances || [];
      const segments = utterances.map((u: any) => ({
        start: u.start,
        end: u.end,
        speaker: `Speaker ${u.speaker !== undefined ? u.speaker + 1 : 1}`,
        text: u.transcript
      }));

      if (segments.length === 0) {
        console.warn("[PROCESS] ⚠️ No utterances returned! Deepgram Response sample:", JSON.stringify(dgData).substring(0, 500));
      }

      // Combine full text
      const fallbackText = dgData.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
      const fullText = segments.length > 0 
          ? segments.map((s: any) => `${s.speaker}: ${s.text}`).join('\n\n')
          : fallbackText;

      const transcriptionMetadata = {
        model: 'deepgram-nova-2',
        process_time_ms: processingTime,
        detected_language: detectedLang,
        timestamp: new Date().toISOString()
      };

      // 6. Update Database with Result (USING ADMIN)
      if (dbRow?.id) {
        console.log(`[DB] 💾 Saving results for record ${dbRow.id}`);
        const { error: updateError } = await supabaseAdmin
          .from('trans_media_transcriptions')
          .update({
            transcription_text: fullText,
            original_language: detectedLang === 'ar' ? 'Arabic' : (detectedLang === 'en' ? 'English' : 'Mixed'),
            processing_time_ms: processingTime,
            status: 'completed',
            transcription_metadata: transcriptionMetadata,
            segments: segments
          })
          .eq('id', dbRow.id);
        
        if (updateError) {
          console.error("[DB] ❌ Update Error:", updateError.message);
          throw new Error("Failed to save transcription results to database: " + updateError.message);
        }
      }

      return new Response(JSON.stringify({ 
        success: true, 
        transcription: fullText,
        message: "Success",
        debug: { processingTime, deepgramResponse: dgData }
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })

    } catch (innerErr: any) {
      console.error("[PROCESS] ❌ Inner Error:", innerErr.message);
      // Update DB with failure
      if (dbRow?.id) {
        await supabaseClient
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

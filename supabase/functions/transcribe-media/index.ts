import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { encode } from "https://deno.land/std@0.168.0/encoding/base64.ts"

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"

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
    
    // 1. Initialize Supabase Client
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader || '' } } }
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

    const OPENROUTER_KEY = Deno.env.get('OPENROUTER_API_KEY');
    if (!OPENROUTER_KEY) {
      console.error("[ERROR] 🔑 OPENROUTER_API_KEY is missing from Deno.env");
      throw new Error("API Key missing");
    }

    // 2.5 Initialize Row in Database
    const { data: dbRow, error: dbInitError } = await supabaseClient
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

    if (dbInitError) console.warn("[DB] ⚠️ Could not initialize record:", dbInitError.message);

    const startTime = Date.now();

    try {
      // 3. Process Media to Base64 (with aggressive memory clearing)
      console.log(`[PROCESS] 📥 Downloading media: ${filePath}`);
      const { data: fileData, error: downloadError } = await supabaseClient
        .storage
        .from('trans_media_assets') // Updated to use the new bucket name
        .download(filePath)

      if (downloadError || !fileData) {
        throw new Error("Failed to download media file from storage: " + downloadError?.message)
      }

      const fileSizeMB = (fileData.size / 1024 / 1024).toFixed(2);
      console.log(`[PROCESS] 🔄 Encoding media (${fileSizeMB} MB)`);
      
      let base64Data: string | null = null;
      {
         const arrayBuffer = await fileData.arrayBuffer();
         const uint8 = new Uint8Array(arrayBuffer);
         base64Data = encode(uint8);
         console.log(`[PROCESS] 💾 Base64 length: ${base64Data.length}`);
      }

      // 4. AI Transcription
      const TRANSCRIBER_PROMPT = `Transcribe this media file accurately. 
      Identify the primary language used (English, Arabic, or Mixed).
      Output your response in the following Markdown format:
      ---
      Language: [English|Arabic|Mixed]
      ---
      ## Visual Context
      [Describe visual scene if video]
      
      ## Transcription
      [The full transcription text]`;

      const aiResponse = await fetch(OPENROUTER_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENROUTER_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: model || 'google/gemini-2.0-flash-001',
          messages: [
            { role: 'user', content: [
              {
                type: 'image_url',
                image_url: { url: `data:${mimeType};base64,${base64Data}` }
              },
              {
                type: 'text',
                text: TRANSCRIBER_PROMPT
              }
            ]}
          ],
          temperature: 0.1,
        })
      })

      // Clear base64 data from memory IMMEDIATELY after fetch starts
      base64Data = null;

      const aiData = await aiResponse.json()
      const endTime = Date.now();
      const processingTime = endTime - startTime;
      console.log(`[PROCESS] ✨ AI Finished in ${(processingTime / 1000).toFixed(1)}s`);

      if (!aiResponse.ok) {
        throw new Error(`AI Provider Error: ${JSON.stringify(aiData)}`);
      }

      const rawContent = aiData.choices?.[0]?.message?.content || "No content returned.";
      
      // Extract language using regex
      const langMatch = rawContent.match(/Language:\s*(English|Arabic|Mixed)/i);
      const detectedLang = langMatch ? langMatch[1] : 'Mixed';
      
      // Clean content (remove the metadata section)
      const aiContent = rawContent.replace(/---[\s\S]*?---/g, '').trim();

      const transcriptionMetadata = {
        model: aiData.model,
        usage: aiData.usage || {},
        process_time_ms: processingTime,
        detected_language: detectedLang,
        timestamp: new Date().toISOString()
      };

      // 5. Update Database with Result
      if (dbRow?.id) {
        await supabaseClient
          .from('trans_media_transcriptions')
          .update({
            transcription_text: aiContent,
            original_language: detectedLang,
            processing_time_ms: processingTime,
            status: 'completed',
            transcription_metadata: transcriptionMetadata
          })
          .eq('id', dbRow.id);
      }

      return new Response(JSON.stringify({ 
        success: true, 
        transcription: aiContent,
        message: "Success",
        debug: {
          model: model || 'google/gemini-2.0-flash-001',
          processingTime
        }
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })

    } catch (innerErr: any) {
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

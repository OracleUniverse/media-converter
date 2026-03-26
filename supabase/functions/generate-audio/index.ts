import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req: any) => {
  console.log(`[ENTRY] 📥 Incoming request: ${req.method}`);
  
  // Handle CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const startTime = Date.now();
    
    // 1. Authenticate user
    const authHeader = req.headers.get('Authorization')
    console.log(`[AUTH] 🔑 Auth Header Length: ${authHeader?.length || 0}`);

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader || '' } } }
    );

    const { data: { user } } = await supabaseClient.auth.getUser();
    
    const userId = user?.id || '00000000-0000-0000-0000-000000000000';
    console.log(`[USER] 👤 Resolved User: ${userId}`);

    // 2. Setup Admin Client for Storage/DB Operations
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    );

    // 3. Parse Request
    const { text, voiceId, voiceName, title } = await req.json();

    if (!text || !voiceId) {
      throw new Error("Text and Voice are required");
    }

    console.log(`[TTS] 🎙️ Generating audio for user ${userId} using ElevenLabs voice: ${voiceName || voiceId}`);

    // 4. Call ElevenLabs API
    const ELEVENLABS_KEY = Deno.env.get('ELEVENLABS_API_KEY');
    if (!ELEVENLABS_KEY) {
      throw new Error("ELEVENLABS_API_KEY secret is missing");
    }

    const elevenLabsUrl = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
    
    // Send request to ElevenLabs
    const elResponse = await fetch(elevenLabsUrl, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg'
      },
      body: JSON.stringify({
        text: text,
        model_id: "eleven_multilingual_v2", // Supports Arabic natively
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75
        }
      })
    });

    if (!elResponse.ok) {
      const errorText = await elResponse.text();
      console.error("[TTS] ❌ ElevenLabs API Error:", errorText);
      throw new Error(`ElevenLabs TTS failed: ${elResponse.status} ${elResponse.statusText}`);
    }

    // Get MP3 ArrayBuffer
    const audioBuffer = await elResponse.arrayBuffer();
    
    if (!audioBuffer || audioBuffer.byteLength === 0) {
      throw new Error("Deepgram returned an empty audio buffer");
    }

    console.log(`[TTS] ✅ Audio generated. Size: ${(audioBuffer.byteLength / 1024 / 1024).toFixed(2)} MB`);

    // 5. Upload to Supabase Storage
    const fileId = crypto.randomUUID();
    const filePath = `${userId}/${fileId}.mp3`;

    console.log(`[TTS] ⬆️ Uploading to storage bucket: ${filePath}`);
    const { error: uploadError } = await supabaseAdmin
      .storage
      .from('tts_audio_assets')
      .upload(filePath, audioBuffer, {
        contentType: 'audio/mpeg',
        upsert: false
      });

    if (uploadError) {
      console.error("[TTS] ❌ Storage Upload Error:", uploadError.message);
      throw new Error("Failed to upload generated audio: " + uploadError.message);
    }

    // 6. Save Record in Database
    const processingTime = Date.now() - startTime;
    console.log(`[TTS] 💾 Saving record to tts_history...`);
    
    const { data: dbData, error: dbError } = await supabaseAdmin
      .from('tts_history')
      .insert({
        user_id: userId,
        title: title || text.substring(0, 50).trim() + "...",
        text_content: text,
        voice_model: voiceName || voiceId,
        storage_path: filePath,
        duration_ms: processingTime,
        status: 'completed'
      })
      .select()
      .single();

    if (dbError) {
      console.error("[TTS] ❌ DB Insert Error:", dbError.message);
      throw new Error("Failed to save generation history: " + dbError.message);
    }

    console.log(`[TTS] 🎉 Successfully completed in ${processingTime}ms!`);

    return new Response(JSON.stringify({ 
      success: true, 
      record: dbData,
      message: "Audio generated successfully",
      debug: { processingTime }
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (err: any) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[FATAL ERROR] ❌ ${errorMsg}`);

    return new Response(JSON.stringify({ 
      success: false,
      error: errorMsg, 
    }), { 
      status: 200, // Return 200 to allow client to parse error JSON
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    })
  }
})

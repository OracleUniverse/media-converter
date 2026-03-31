import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req: any) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader || '' } } }
    )

    const { text, recordId, language } = await req.json();
    if (!text) throw new Error("Missing text to summarize");

    // 1. Determine target language (priority: passed param > DB check > same as input)
    let targetLanguage = language || 'the same as the input text';
    
    if (!language && recordId) {
      console.log(`[SUMMARIZE] 🔍 Fetching language for record ${recordId} (fallback)`);
      const { data: record } = await supabaseClient
        .from('trans_media_transcriptions')
        .select('original_language')
        .eq('id', recordId)
        .single();
      
      if (record?.original_language && record.original_language !== 'Mixed') {
        targetLanguage = record.original_language;
      }
    }
    
    console.log(`[SUMMARIZE] 🌐 Summary language: ${targetLanguage}`);

    const OPENROUTER_KEY = Deno.env.get('OPENROUTER_API_KEY') || Deno.env.get('VITE_GEMINI_API_KEY');
    if (!OPENROUTER_KEY) {
      console.error("[SUMMARIZE] ❌ API Key missing");
      throw new Error("API Key missing. Please set OPENROUTER_API_KEY in Supabase secrets.");
    }

    const aiResponse = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-3-flash-preview',
        messages: [
          { 
            role: 'system', 
            content: `You are a helpful assistant that summarizes long transcriptions into exactly 3 concise bullet points. 
            CRITICAL: You MUST write the summary in ${targetLanguage}. 
            If the input is mixed, use the dominant language.` 
          },
          { 
            role: 'user', 
            content: `Please summarize the following transcription:\n\n${text}` 
          }
        ],
        temperature: 0.3,
      })
    })

    const aiData = await aiResponse.json()
    if (!aiResponse.ok) throw new Error(`AI Provider Error: ${JSON.stringify(aiData)}`);

    const summary = aiData.choices?.[0]?.message?.content || "Could not generate summary.";

    // Update database if recordId is provided
    if (recordId) {
      const { error: dbError } = await supabaseClient
        .from('trans_media_transcriptions')
        .update({ summary: summary })
        .eq('id', recordId);
      
      if (dbError) console.error("[SUMMARIZE] ❌ DB Update Error:", dbError.message);
    }

    return new Response(JSON.stringify({ 
      success: true, 
      summary,
      metadata: {
        model: aiData.model,
        usage: aiData.usage || {},
        timestamp: new Date().toISOString()
      }
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (err: any) {
    return new Response(JSON.stringify({ success: false, error: err.message }), { 
      status: 500, 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    })
  }
})

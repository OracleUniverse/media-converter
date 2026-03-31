import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { text, targetLanguage } = await req.json()
    
    if (!text || !targetLanguage) {
      throw new Error("Missing text or targetLanguage")
    }

    const OPENROUTER_KEY = Deno.env.get('OPENROUTER_API_KEY');
    if (!OPENROUTER_KEY) {
      throw new Error("API Key missing");
    }

    const startTime = Date.now();
    console.log(`[TRANSLATE] START: Translation process to ${targetLanguage} initiated.`);
    console.log(`[TRANSLATE] INPUT: Length: ${text.length} characters.`);

    const response = await fetch(OPENROUTER_API_URL, {
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
            content: `You are a professional translator. Translate the given text to ${targetLanguage}. 
            Maintain the original tone and formatting (Markdown). 
            Output ONLY the translated text, nothing else.` 
          },
          { role: 'user', content: text }
        ],
        temperature: 0.3,
      })
    })

    const data = await response.json();
    const endTime = Date.now();
    const duration = endTime - startTime;

    if (!response.ok) {
        console.error(`[TRANSLATE] ERROR: AI Provider rejected request.`, data);
        throw new Error(`AI Provider Error: ${JSON.stringify(data)}`);
    }

    const translatedText = data.choices?.[0]?.message?.content || "";
    const metadata = {
        model: data.model,
        usage: data.usage || {},
        process_time_ms: duration,
        target_language: targetLanguage,
        input_length: text.length,
        output_length: translatedText.length,
        timestamp: new Date().toISOString()
    };

    console.log(`[TRANSLATE] SUCCESS: Finished in ${duration}ms. Tokens used: ${data.usage?.total_tokens || 'N/A'}`);

    return new Response(JSON.stringify({ translatedText, metadata }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { 
      status: 500, 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    })
  }
})

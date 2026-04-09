const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const body = await req.json()
    const { images, model, dimensions, overridePrompt } = body
    
    if (!images || images.length === 0) throw new Error("No images provided")

    const OPENROUTER_KEY = Deno.env.get('OPENROUTER_API_KEY');
    if (!OPENROUTER_KEY) throw new Error("OPENROUTER_API_KEY missing.");

    const chosenModel = model || 'google/gemini-2.0-flash-001';
    const pageWidth = dimensions?.width || 1024;
    const pageHeight = dimensions?.height || 1448;

    const SYSTEM_PROMPT = overridePrompt 
      ? `${overridePrompt}` 
      : `
Role: Forensic Document Architect & Forensic Grid Layout Engineer.

Objective:
Perform a complete forensic reconstruction of the provided document image into a pixel-accurate HTML digital twin using a STRICT TABLE-FIRST ARCHITECTURE.

====================================================
CRITICAL FORENSIC RULES (STRICT ADHERENCE)
====================================================

1. ABSOLUTE CHART BLACK-BOX (PRIORITY 1): Identify all visual visualizations FIRST.
   - DEFINITION: Any element containing non-textual graphical ink (Bars, Pie Slices, Axis Lines, Curves, or Legend Icons ■).
   - MANDATORY SILENCE: If an element is a Chart/Logo, you are STRICTLY FORBIDDEN from extracting any text or numbers from it. You MUST output ONLY the placeholder <table>.

2. STRUCTURAL TABLE SUPREMACY (PRIORITY 2): Grids of PURE readable text (Invoices, Financials, Schedules, Contact Lists) are structural.
   - RULE: If a grid is 100% alphanumeric text/numbers and lacks graphical ink (no axes, no bars), extract it as a real HTML <table>. 

3. VISIBLE ARTIFACT PLACEHOLDERS: For EVERY graphical artifact identified in Rule #1, output ONLY the dashed <table> box:
   <table data-artifact-id="artifact_N" style="width:100%; border:2px dashed #cbd5e1; background:#f8fafc; mso-height-rule:exactly; height:150px; text-align:center; vertical-align:middle;">
     <tr style="mso-height-rule:exactly; height:150px;">
       <td style="mso-height-rule:exactly; height:150px;"><b>[ARTIFACT TYPE] PLACEHOLDER</b></td>
     </tr>
   </table>

4. GRID INTEGRITY (LAYOUT): Use side-by-side <td> cells for page columns. 
   - SIDE-BY-SIDE: If two artifacts are horizontal, you MUST use one <tr> with two <td style="width:50%;"> cells. NEVER stack them in a single cell or multiple rows. 
   - HEIGHTS: Use height:auto for all text rows.

5. NO MODERN CSS: Use rigid HTML <table> including the page wrapper: <div style="width: ${pageWidth}px; min-height: ${pageHeight}px; background: white; margin: 0 auto; font-family: Arial, sans-serif;">...</div>

6. RECORD STRUCTURAL TEXT ONLY: Output titles and paragraphs. Use fluid heights (height:auto).

STRICT TECHNICAL RULES:
1. RESPONSE MUST BE JSON (DO NOT OMIT THIS):
{
  "html": "...",
  "artifacts": [
    {
      "id": "artifact_1",
      "type": "chart | logo | photo",
      "description": "Short description",
      "bbox": [ymin, xmin, ymax, xmax]
    }
  ]
}
2. BBOX COORDINATES: Use absolute pixels matching ${pageWidth}x${pageHeight}.
3. NO BASE64 DATA.
4. NO LAZY OUTPUTS.
5. YOUR ENTIRE RESPONSE MUST BE A VALID JSON OBJECT.
`;

    const isGptModel = chosenModel.includes('gpt-');
    const isClaudeModel = chosenModel.includes('claude-');
    const maxTokens = isGptModel ? 4096 : (isClaudeModel ? 8192 : 30000);

    console.log(`📡 Sending request to OpenRouter [${chosenModel}] (max_tokens: ${maxTokens})...`);

    const aiResponse = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://media-converter.supabase.co', // Recommended by OpenRouter
        'X-Title': 'PDF Forensic Media Converter',           // Recommended by OpenRouter
      },
      body: JSON.stringify({
        model: chosenModel,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: `Reconstruct this page layout as a valid JSON object. Resolution: ${pageWidth}x${pageHeight}.` },
              ...images.map((img: any) => ({
                type: 'image_url',
                image_url: { url: `data:${img.mimeType};base64,${img.data}` }
              }))
            ]
          }
        ],
        temperature: 0.1,
        max_tokens: maxTokens,
        response_format: overridePrompt ? undefined : { type: "json_object" }
      })
    });

    const aiData = await aiResponse.json();
    
    if (aiData.error) {
        console.error("OpenRouter API Error:", aiData.error);
        throw new Error(`OpenRouter Error: ${aiData.error.message || JSON.stringify(aiData.error)}`);
    }

    let rawText = aiData.choices?.[0]?.message?.content || "";
    const finishReason = aiData.choices?.[0]?.finish_reason || "unknown";
    
    console.log(`📥 Raw AI Response (Length: ${rawText.length}, Reason: ${finishReason}):`, rawText.substring(0, 200) + (rawText.length > 200 ? "..." : ""));
    
    // Safety check for empty content
    if (!rawText || rawText.trim().length === 0) {
        return new Response(JSON.stringify({
            success: false,
            error: `AI returned empty content. Finish Reason: ${finishReason}`,
            finishReason,
            rawAiOutput: rawText,
            usage: aiData.usage
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    
    let finalPayload;
    
    // SIMPLE CLONE MIRROR MODE (v33)
    if (overridePrompt) {
        console.log("🚀 Raw Text Mode Active (AI Studio Mirror)");
        let code = rawText.trim();
        
        // Strip markdown code blocks
        if (code.startsWith("```")) {
            code = code.replace(/^```[a-z]*\n/i, "").replace(/\n```$/m, "");
        }

        // IMPROVED: Truncated JSON Extractor
        if (code.includes('"html":')) {
            const htmlMatch = code.match(/"html":\s*"(.*)/s);
            if (htmlMatch) {
                let extracted = htmlMatch[1];
                extracted = extracted.replace(/"\s*,\s*"artifacts".*$/s, "");
                extracted = extracted.replace(/"\s*}\s*$/s, "");
                code = extracted.replace(/\\n/g, "\n").replace(/\\"/g, '"');
            }
        } else if (code.startsWith("{")) {
            try {
                const parsed = JSON.parse(code);
                if (parsed.html) code = parsed.html;
            } catch { /* Fallback to raw */ }
        }
        
        code = code.replace(/\\n/g, "\n");
        finalPayload = { html: code, artifacts: [] };
    } else {
        const firstBrace = rawText.indexOf('{');
        const lastBrace = rawText.lastIndexOf('}');
        if (firstBrace !== -1) {
             rawText = rawText.substring(firstBrace, lastBrace !== -1 ? lastBrace + 1 : rawText.length);
        }

        const cleanRaw = [...rawText]
          .filter(c => {
            const code = c.charCodeAt(0);
            return code >= 32 || code === 10 || code === 13 || code === 9;
          })
          .join('');

        try {
          finalPayload = JSON.parse(cleanRaw);
        } catch {
          console.warn("JSON Parse failed, attempting forensic repair...");
          try {
            let fixed = cleanRaw.trim();
            fixed = fixed.replace(/\n/g, "\\n").replace(/\r/g, "\\r");
            const quoteCount = (fixed.match(/"/g) || []).length;
            if (quoteCount % 2 !== 0) fixed = fixed.replace(/\\n$/, "") + '"'; 
            if (!fixed.endsWith('}')) fixed += '}';
            if (fixed.includes('[') && !fixed.endsWith(']}')) {
                if (!fixed.endsWith('"')) fixed += '"';
                fixed += ']}';
                if (!fixed.endsWith('}')) fixed += '}';
            }
            finalPayload = JSON.parse(fixed);
          } catch {
            finalPayload = { html: `<!-- REPAIR FAILED -->\n${cleanRaw}`, artifacts: [] };
          }
        }
    }

    return new Response(JSON.stringify({ 
      success: true, 
      html: finalPayload.html,
      artifacts: finalPayload.artifacts || [],
      usage: aiData.usage || {},
      resolution: { width: pageWidth, height: pageHeight },
      finishReason,
      rawAiOutput: rawText
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (error: any) {
    console.error("Error:", error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})

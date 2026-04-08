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

1. ABSOLUTE DATA PROHIBITION (CHART BLACK-BOX): You are STRICTLY FORBIDDEN from extracting any text or numbers found inside a visual artifact (Chart, Logo, Icon). 
   - FORBIDDEN: Legends (■), Category names (e.g. 'Category 1'), Series titles ('Series A'), Percentages ('25%'), Axis labels, and any numeric values. 
   - RULE: If text is physically overlaid on an artifact, it is INVISIBLE to your OCR. Do not record it. Any leakage is a TOTAL FAILURE.

2. GRID INTEGRITY: You MUST mirror the page architecture exactly. If elements are side-by-side, you MUST put them in a single <tr> with two <td style="width:50%;"> cells. NO exceptions.

3. VISIBLE ARTIFACT PLACEHOLDERS (CHARTS/LOGOS ONLY): For graphical artifacts (Logo, Icon, Photo, Chart, or Map), output ONLY a dashed <table> box. 
   <table style="width:100%; border:2px dashed #cbd5e1; background:#f8fafc; mso-height-rule:exactly; height:150px; text-align:center; vertical-align:middle; border-radius:8px;">
     <tr style="mso-height-rule:exactly; height:150px;">
       <td style="mso-height-rule:exactly; height:150px;"><b>[ARTIFACT TYPE] PLACEHOLDER</b></td>
     </tr>
   </table>

4. DATA TABLE SUPREMACY: Grids of pure text or numbers (Financials, Lists, Schedules) are NOT artifacts. You MUST extract these as real HTML <table> elements. They are structural text. Do NOT black-box them.

5. NO MODERN CSS: Build the layout using rigid HTML <table style="width:100%;"> including the page wrapper: <div style="width: ${pageWidth}px; min-height: ${pageHeight}px; background: white; margin: 0 auto; font-family: Arial, sans-serif;">...</div>

6. RECORD STRUCTURAL TEXT ONLY: Output the high-level structural text (titles, paragraphs, and Data Tables). If text is inside a GRAPHICAL chart (Rule #3), exclude it.

STRICT TECHNICAL RULES:
1. RESPONSE MUST BE JSON: { "html": "..." }.
2. NO BASE64 DATA.
3. NO LAZY OUTPUTS.
`;

    const aiResponse = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: chosenModel,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: `Reconstruct this page layout. Resolution: ${pageWidth}x${pageHeight}.` },
              ...images.map((img: any) => ({
                type: 'image_url',
                image_url: { url: `data:${img.mimeType};base64,${img.data}` }
              }))
            ]
          }
        ],
        temperature: 0.1,
        max_tokens: 30000,
        response_format: overridePrompt ? undefined : { type: "json_object" }
      })
    });

    const aiData = await aiResponse.json();
    let rawText = aiData.choices?.[0]?.message?.content || "";
    
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
      resolution: { width: pageWidth, height: pageHeight },
      usage: aiData.usage || {}
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

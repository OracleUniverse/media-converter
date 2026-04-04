import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
}

console.log("🚀 Edge Function: reconstruct-pdf-html (Absolute-Pixel V18 Logic) starting...")

serve(async (req: any) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const body = await req.json()
    const { images, model, dimensions } = body // Accept physical dimensions
    
    if (!images || images.length === 0) throw new Error("No images provided")

    const OPENROUTER_KEY = Deno.env.get('OPENROUTER_API_KEY');
    if (!OPENROUTER_KEY) throw new Error("OPENROUTER_API_KEY missing.");

    const chosenModel = model || 'google/gemini-2.0-flash-001';
    const pageWidth = dimensions?.width || 1024;
    const pageHeight = dimensions?.height || 1448;

    const SYSTEM_PROMPT = `ROLE:
You are a Document Layout Reconstruction Engine specializing in visual analysis, grid reconstruction, semantic grouping, and spatial extraction.

OBJECTIVE:
From a document image, generate:
1. A structurally accurate HTML representation
2. Precise spatial metadata (bounding boxes) for artifacts

Both must reflect the original document with high fidelity.

====================================================
MASTER EXECUTION ORDER (STRICT)
===============================
Follow EXACTLY this order:
1. Detect ALL text blocks and visual elements
2. Build COMPONENTS (group related elements)
3. Group into SECTIONS
4. Build GRIDS using components
5. Normalize grid structure (rows/columns)
6. Assign standalone text blocks to rows
7. Render HTML
8. Extract spatial metadata (bbox, aspect ratio)
9. Validate and fix inconsistencies

====================================================
CORE DEFINITIONS
================
COMPONENT: A self-contained visual unit (Chart block, Image block, Table block).
RULE: Each COMPONENT must exist in ONE cell only.

TEXT BLOCK: Any standalone text not part of a component.

====================================================
GLOBAL RULES (NON-NEGOTIABLE)
=============================
1. GRID DOMINANCE: Grid structure overrides component size. All columns must be equal width.
2. COMPONENT INTEGRITY: A component MUST NOT be split across rows or cells.
3. TEXT COMPLETENESS: ALL visible text MUST be extracted.
4. NO FLOATING ELEMENTS: Every element MUST belong to a row and cell.
5. SECTION ISOLATION: Sections MUST NOT share grids.

====================================================
LAYOUT & RENDERING
===================
PHASE 9: HTML RENDERING
Use table-based layout: <table style="width:100%; border-collapse:collapse;">
<tr> → row
<td> → cell

PHASE 10: COMPONENT RENDERING
<td>
  <div class="component" style="display:flex; flex-direction:column; gap:8px;">
    <div class="component-title">...</div>
    <div class="artifact-placeholder" data-artifact-id="artifact_X"></div>
    <div class="component-caption">...</div>
  </div>
</td>

PHASE 11: TEXT RENDERING
Use: <h1>, <h2>, <h3> → titles | <p> → paragraphs | <span> → small text

PHASE 13: OVERLAP PREVENTION
FORBIDDEN: absolute positioning, negative margins. Use: table row/cell and flex column layout.

PHASE 15: SPATIAL METADATA (MODIFIED TO ABSOLUTE PIXELS)
Return: id, type, description, bbox: [ymin, xmin, ymax, xmax], aspect_ratio.
Coordinates MUST be in ABSOLUTE PIXELS corresponding to a ${pageWidth}x${pageHeight} resolution.

PHASE 16: DIMENSION RULES
WIDTH: controlled ONLY by grid. HEIGHT: derived from content.

====================================================
FINAL OUTPUT
============
Return ONLY JSON:
{
  "html": "<full html document>",
  "artifacts": [
    {
      "id": "artifact_1",
      "type": "chart",
      "description": "Chart Description",
      "bbox": [ymin, xmin, ymax, xmax],
      "aspect_ratio": 1.6
    }
  ]
}
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
              { type: 'text', text: `Reconstruct this page layout into a semantic HTML Grid. The image resolution provided is ${pageWidth}x${pageHeight}. All BBox coordinates MUST be relative to this resolution.` },
              ...images.map((img: any) => ({
                type: 'image_url',
                image_url: { url: `data:${img.mimeType};base64,${img.data}` }
              }))
            ]
          }
        ],
        temperature: 0.1,
        max_tokens: 8000,
        response_format: { type: "json_object" }
      })
    });

    const aiData = await aiResponse.json();
    let rawText = aiData.choices?.[0]?.message?.content || "";
    
    // Safety Parsing
    const firstBrace = rawText.indexOf('{');
    const lastBrace = rawText.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) {
         rawText = rawText.substring(firstBrace, lastBrace + 1);
    }
    
    const finalPayload = JSON.parse(rawText);

    return new Response(JSON.stringify({ 
      success: true, 
      html: finalPayload.html,
      artifacts: finalPayload.artifacts || [],
      resolution: { width: pageWidth, height: pageHeight } // Confirm resolution back
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (error: any) {
    console.error("Error in reconstruct Edge Function:", error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})

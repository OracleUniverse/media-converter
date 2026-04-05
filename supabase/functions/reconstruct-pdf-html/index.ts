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

Both must reflect the original document with high-fidelity.

====================================================
PHASE 0: DIRECTION & LANGUAGE DETECTION (CRITICAL)
====================================================
1. Detect the primary document language.
2. If the language is Arabic, Hebrew, or any Right-to-Left (RTL) language:
   - YOU MUST set [dir="rtl"] on the root <table> and all <div> elements.
   - Use standard Arabic-friendly tags and ensure alignment is anchored to the right.

====================================================
MASTER EXECUTION ORDER (STRICT)
===============================
Follow EXACTLY this order:
1. Group elements into components FIRST.
2. Detect ALL text blocks and visual elements
3. Build COMPONENTS (group related elements)
4. Group into SECTIONS
5. Build GRIDS using components (respecting RTL if applicable)
6. Normalize grid structure (rows/columns)
7. Assign standalone text blocks to rows
8. Render HTML
9. Extract spatial metadata (bbox, aspect ratio)
10. Validate and fix inconsistencies

====================================================
CORE DEFINITIONS
================
COMPONENT: A self-contained visual unit (Chart block, Image block, Table block).
CHART COMPONENT: A chart component consists of [TITLE (text) + CHART (visual) + CAPTION (text/stats)]. These MUST be treated as ONE component.
RULE: Each COMPONENT must exist in ONE cell only.
TEXT BLOCK: Any standalone text not part of a component.
UNCERTAINTY RULE: If uncertain about grouping → keep text as a separate standalone block (do not merge incorrectly).

====================================================
GLOBAL RULES (NON-NEGOTIABLE)
=============================
1. GRID DOMINANCE: Grid structure overrides component size. All columns must be equal width.
2. COMPONENT INTEGRITY: A component MUST NOT be split across rows or cells. 
   - NEVER separate a title from its chart.
3. TEXT COMPLETENESS: ALL visible text MUST be extracted.
4. SYMBOL PRESERVATION: Preserve all dotted lines (.........), bullet points (including the hollow circle '◦'), and special characters used for form-filling. 
   - Ensure '◦' is correctly anchored to the RIGHT of the text in RTL mode.
5. NO FLOATING ELEMENTS: Every element MUST belong to a row and cell.
6. SECTION ISOLATION: Sections MUST NOT share grids.

====================================================
TABLE FIDELITY (HIGH PRIORITY)
=============================
1. If a structured table with borders is detected (even thin borders), you MUST preserve it as a <table> structure.
2. MAINTAIN CELL COUNT: Ensure the row and column count exactly matches the original.
3. BORDERS: If borders are visible, use <table border="1"> in your output.
4. ALIGNMENT: For table head segments or any cell acting as a header (e.g., the top row of a grid), use [text-align: center] and [font-weight: bold] in your markup.

====================================================
VISUAL ARTIFACT INTEGRITY (CRITICAL)
=====================================
1. When providing a BBox for a CHART or VISUAL ARTIFACT, you MUST capture the COMPLETE visual unit.
2. COMPREHENSIVE CROPPING: If the artifact is a chart, the BBox MUST include:
   - The entire plot area (bars, lines, slices).
   - ALL Axis labels and tick marks.
   - The COMPLETE Legend.
3. EXCLUSION RULE: Omit any titles or subtitles that are rendered as part of the graphic from the artifact BBox (for now).
4. TRUNCATION IS FORBIDDEN: It is better to provide a slightly larger BBox than to crop a label or legend partially.

====================================================
LAYOUT & RENDERING
===================
PHASE 9: HTML RENDERING
Use table-based layout: <table style="width:100%; border-collapse:collapse;"> (Add dir="rtl" if Arabic/Hebrew).
<tr> → row
<td> → cell

PHASE 10: COMPONENT RENDERING
<td>
  <div class="component" style="display:flex; flex-direction:column; gap:8px;">
    // TITLE (text) + CHART (artifact) + CAPTION (text) = ONE UNIT
    <div class="component-title" style="font-weight:bold; margin-bottom:4px; text-align:inherit;">...</div>
    <div class="artifact-placeholder" data-artifact-id="artifact_X"></div>
    <div class="component-caption" style="font-size:0.9em; color:#666; margin-top:4px;">...</div>
  </div>
</td>

PHASE 11: TEXT RENDERING
Use: <h1>, <h2>, <h3> → titles | <p> → paragraphs | <span> → small text

PHASE 13: OVERLAP PREVENTION
FORBIDDEN: absolute positioning, negative margins. Use: table row/cell and flex column layout.

PHASE 15: SPATIAL METADATA (ABSOLUTE PIXELS)
Return: id, type, description, bbox: [ymin, xmin, ymax, xmax], aspect_ratio.
Coordinates MUST be in ABSOLUTE PIXELS corresponding to a ${pageWidth}x${pageHeight} resolution.

PHASE 16: DIMENSION RULES
1. MASTER DIMENSIONS: The physical dimensions (width, height) of visual artifacts are DEFINED by the returned BBox.
2. NO DISTORTION: Grid scaling MUST NOT distort or scale these dimensions. The HTML should respect the BBox pixels.

====================================================
JSON ESCAPING RULES (ABSOLUTE)
==============================
1. INTERNAL QUOTES: You MUST escape all double quotes inside the HTML content as [\\"].
2. NO LITERAL NEWLINES: Do NOT use literal line breaks inside JSON strings. Use [\\n] instead.
3. FORBIDDEN CHARACTERS: Do not use any control characters or unescaped backslashes.

====================================================
FINAL OUTPUT
============
Return ONLY JSON:
{
  "html": "<full html document>",
  "direction": "rtl" | "ltr",
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
        max_tokens: 16000,
        cache_control: { type: "no-cache" },
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

    let finalPayload;
    // Remove control characters using a linter-friendly character filter
    const cleanRaw = [...rawText]
      .filter(c => {
        const code = c.charCodeAt(0);
        return code >= 32 || code === 10 || code === 13 || code === 9;
      })
      .join('');

    try {
      finalPayload = JSON.parse(cleanRaw);
    } catch (e) {
      console.error("Initial JSON parse failed, attempting repair... Snippet:", cleanRaw.substring(0, 100));
      try {
        let fixedText = cleanRaw.trim();
        // Check for unterminated string
        const quoteCount = (fixedText.match(/"/g) || []).length;
        if (quoteCount % 2 !== 0 && !fixedText.endsWith('"')) fixedText += '"'; 
        
        if (!fixedText.endsWith('}')) fixedText += '"}';
        if (!fixedText.endsWith(']}')) fixedText += ']}';
        finalPayload = JSON.parse(fixedText);
      } catch {
        throw new Error(`JSON Structure Error: ${e.message}. The AI response contained an unescaped character or was truncated.`);
      }
    }

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

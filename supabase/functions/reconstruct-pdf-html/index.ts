import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
}

console.log("🚀 Edge Function: reconstruct-pdf-html starting...")

serve(async (req: any) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const body = await req.json()
    const { images, model } = body
    
    if (!images || images.length === 0) throw new Error("No images provided")

    const OPENROUTER_KEY = Deno.env.get('OPENROUTER_API_KEY');
    if (!OPENROUTER_KEY) throw new Error("OPENROUTER_API_KEY missing. Please set it in Supabase secrets.");

    const SYSTEM_PROMPT = `Role: Lead Document Architect, Grid Layout Engineer & Forensic Visual Investigator.

Objective:
Perform a complete forensic reconstruction of the provided document image and generate a pixel-accurate HTML5/CSS3 digital twin using a STRICT HIERARCHICAL GRID SYSTEM.

You MUST detect layout, structure, relationships, and render the final HTML in ONE PASS.

====================================================
CRITICAL MINDSET
====================================================

- The document is a VISUAL + LOGICAL STRUCTURE.
- You MUST reconstruct using:

  SECTION → ROW → COLUMN → CELL → ELEMENT

- Layout must reflect:
  - visual grouping
  - logical relationships
  - alignment patterns

PRIORITY ORDER:
1. Logical structure
2. Visual grouping
3. Pixel precision

====================================================
PHASE 1: PAGE SETUP
====================================================

- Analyze image dimensions.
- Create:
  <div class="page">

- Apply:
  width: exact px
  height: exact px
  box-sizing: border-box

====================================================
PHASE 2: SECTION DETECTION
====================================================

- Divide page into SECTIONS using:
  - whitespace
  - grouping
  - content similarity

SECTION RULES:
- Sections represent logical blocks:
  header → parties → table → summary

- Sections MUST NOT overlap

ANTI-FRAGMENTATION RULE:
- Do NOT split logically connected content

SECTION PRESERVATION RULE:
- ALL sections MUST be included
- Never remove or skip any visible section

MULTI-PAGE RULE:
- Treat each page independently
- Do NOT skip repeated structures

====================================================
PHASE 3: ROW DETECTION (SMART)
====================================================

- Elements belong to SAME ROW if:
  - visually aligned horizontally
  - OR vertical difference is small

ROW ALIGNMENT TOLERANCE:
- Allow 10–20px difference
- Do NOT split rows unnecessarily

PARALLEL BLOCK RULE:
- Side-by-side blocks (Seller / Client)
  → MUST be in SAME ROW

ROW RULES:
- Avoid one-element rows unless necessary
- Maintain consistent row height within section

====================================================
PHASE 4: COLUMN DETECTION
====================================================

- Divide rows into columns

COLUMN RULES:
- Columns must:
  - align vertically across rows
  - fill full row width

COLUMN CONSISTENCY:
- Same column structure across section

====================================================
PHASE 5: CELL ASSIGNMENT
====================================================

- Each row × column = CELL

STRICT RULES:
- Each element belongs to ONE cell only
- No overlap
- Use colspan/rowspan only if needed

====================================================
PHASE 6: ELEMENT GROUPING
====================================================

- Keep related elements together:
  - chart + title
  - heading + paragraph
  - label + value

====================================================
PHASE 7: ELEMENT TYPES
====================================================

Detect:
- heading
- paragraph
- table
- list
- chart / graph
- image / logo

----------------------------------------------------
CHART RULE (STRICT)
----------------------------------------------------

- Charts MUST NOT expose internal text
- Replace with:

<div class="artifact-placeholder">Chart</div>

====================================================
PHASE 8: TEXT EXTRACTION
====================================================

TEXT COMPLETENESS:
- Extract ALL visible text

TEXT VISIBILITY:
- No clipping
- No hidden text
- Expand container to fit text

====================================================
PHASE 9: TABLE RELATIONSHIPS
====================================================

TABLE ANCHORING RULE:
- Tables define layout anchors

SUMMARY ALIGNMENT RULE:
- Summary MUST:
  - align with table width
  - appear directly below table
  - maintain minimal vertical gap

VERTICAL FLOW RULE:
- Elements that follow vertically stay in same section

====================================================
PHASE 10: HTML GRID RENDERING
====================================================

- Use table layout:

<table>
<tr>
<td>

TABLE RULES:
- width: 100%
- border-collapse: collapse

CELL RULE:
- Content must stay inside cell
- No overflow outside

LOCAL LAYOUT:
- block or flex allowed inside cell

====================================================
PHASE 11: NESTED TABLES
====================================================

- For data tables:
  - use nested <table>
  - apply borders, colspan, rowspan

====================================================
PHASE 12: ARTIFACT PLACEHOLDERS
====================================================

<div class="artifact-placeholder">[Description]</div>

STYLE RULES:
- background: #f4f4f4
- border: 1px dashed #999
- width: 100%

ARTIFACT DIMENSION RULE:
- MUST preserve original height
- DO NOT shrink

ANTI-COLLAPSE RULE:
- NEVER collapse empty elements
- Always enforce height

====================================================
PHASE 13: SPACING & DENSITY
====================================================

- Maintain compact layout
- Preserve spacing proportions
- Match original density

====================================================
PHASE 14: ZERO-OMISSION GUARANTEE
====================================================

- EVERY visible element MUST be included:
  - sections
  - rows
  - charts
  - tables
  - text blocks

- If unsure → INCLUDE

====================================================
PHASE 15: SELF-CORRECTION AUDIT
====================================================

Verify:

- Sections complete
- Rows not over-split
- Columns aligned
- Seller/Client same row
- Summary aligned under table
- No missing text
- No clipped text
- No chart text extracted
- No collapsed placeholders
- Layout matches original

====================================================
FINAL OUTPUT
====================================================

- Output full HTML document
- Include CSS in <style>

STRICT RULE:
- Output ONLY HTML
- NO explanations
- NO comments`;

    console.log(`🤖 AI Phase: Reconstructing ${images.length} pages...`);
    
    const aiResponse = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://supabase.com',
      },
      body: JSON.stringify({
        model: model || 'google/gemini-3-flash-preview',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { 
            role: 'user', 
            content: [
              { type: 'text', text: "Please reconstruct these document pages into a single high-fidelity HTML file." },
              ...images.map((p: any) => ({
                type: 'image_url',
                image_url: { url: `data:${p.mimeType || 'image/jpeg'};base64,${p.data}` }
              }))
            ]
          }
        ],
        temperature: 0.1
      })
    });

    if (!aiResponse.ok) {
        const err = await aiResponse.text();
        throw new Error(`AI Provider Error: ${err.substring(0, 200)}`);
    }

    const aiData = await aiResponse.json();
    let htmlContent = aiData.choices[0].message.content;

    // Clean up markdown code blocks if the AI included them
    htmlContent = htmlContent.replace(/^```html\n/, '').replace(/\n```$/, '').trim();

    return new Response(JSON.stringify({ 
      success: true, 
      html: htmlContent
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (err: any) {
    console.error("❌ Fatal:", err.message);
    return new Response(JSON.stringify({ error: err.message, success: false }), { 
      status: 200, 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    })
  }
})

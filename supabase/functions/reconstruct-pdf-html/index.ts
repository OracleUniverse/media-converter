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
  header → content → tables → structured numeric blocks

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
- Side-by-side blocks MUST be in SAME ROW

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
  - label + value pairs

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
- structured_numeric_block

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
PHASE 9: STRUCTURED NUMERIC BLOCKS (CRITICAL)
====================================================

DEFINITION:
- A structured numeric block contains:
  - label + numeric values
  - totals, balances, percentages, financial/statistical summaries

----------------------------------------------------
TYPE DETECTION
----------------------------------------------------

TYPE 1: KEY-VALUE PAIRS
- Format: label → value

TYPE 2: TABULAR NUMERIC GRID
- Format: multiple aligned numeric columns

Detection conditions for TYPE 2:
- ANY row contains multiple numeric values
- numeric values align horizontally
- repeated numeric patterns exist

----------------------------------------------------
COLUMN PROPAGATION RULE (CRITICAL)
----------------------------------------------------

- If ANY row contains multiple numeric values:
  → ENTIRE block becomes multi-column table

- ALL rows MUST:
  - have SAME number of columns
  - preserve vertical alignment

- Missing values MUST be filled with empty cells

----------------------------------------------------
HEADER NORMALIZATION RULE (CRITICAL)
----------------------------------------------------

- You MUST create ONE unified header row

- Collect all column labels:
  (e.g., Net worth, VAT, Gross worth)

- Place them in FIRST row:

  [Label] | [Col1] | [Col2] | [Col3]

- Headers MUST NOT appear in multiple rows

----------------------------------------------------
COLUMN ROLE SEPARATION
----------------------------------------------------

- First column = LABEL column (text)
- Remaining columns = NUMERIC columns

- NEVER mix labels and numbers across columns

----------------------------------------------------
ROW NORMALIZATION RULE (CRITICAL)
----------------------------------------------------

- EVERY row MUST follow:

  [Label] | [Value1] | [Value2] | [Value3]

- If a row has fewer values:
  → fill remaining cells with empty values

----------------------------------------------------
RENDERING RULES
----------------------------------------------------

TYPE 1:
- Render as 2-column table

TYPE 2:
- Render as FULL TABLE:
  <table>
    <tr> (headers)
    <tr> (rows)
  </table>

----------------------------------------------------
ALIGNMENT RULES
----------------------------------------------------

- Labels → left-aligned
- Numeric values → right-aligned
- All numeric columns MUST align vertically

----------------------------------------------------
CONSISTENCY RULE
----------------------------------------------------

- All rows MUST share identical column count
- Mixed layouts are NOT allowed

----------------------------------------------------
ANCHORING RULE
----------------------------------------------------

- If below a table:
  → align with table width
  → place directly below

----------------------------------------------------
EMPHASIS RULE
----------------------------------------------------

- Final row (Total) MUST be emphasized:
  - bold OR stronger border OR background

----------------------------------------------------
ANTI-FLAT RULE
----------------------------------------------------

- NEVER render as plain text
- ALWAYS use table structure

FAILURE CONDITION:
- Misaligned numbers OR mixed column structure OR scattered headers

====================================================
PHASE 10: TABLE RELATIONSHIPS
====================================================

TABLE ANCHORING RULE:
- Tables define layout anchors

VERTICAL FLOW RULE:
- Elements that follow vertically stay in same section

====================================================
PHASE 11: HTML GRID RENDERING
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
PHASE 12: NESTED TABLES
====================================================

- For data tables:
  - use nested <table>
  - apply borders, colspan, rowspan

====================================================
PHASE 13: ARTIFACT PLACEHOLDERS
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
PHASE 14: SPACING & DENSITY
====================================================

- Maintain compact layout
- Preserve spacing proportions
- Match original density

====================================================
PHASE 15: ZERO-OMISSION GUARANTEE
====================================================

- EVERY visible element MUST be included:
  - sections
  - rows
  - charts
  - tables
  - structured numeric blocks
  - text blocks

- If unsure → INCLUDE

====================================================
PHASE 16: SELF-CORRECTION AUDIT
====================================================

Verify:

- Sections complete
- Rows not over-split
- Columns aligned
- No missing text
- No clipped text
- No chart text extracted
- No collapsed placeholders
- Structured numeric blocks rendered as tables
- Numeric columns aligned perfectly
- Column count consistent across rows
- Headers unified in one row
- Layout matches original

====================================================
FINAL OUTPUT
====================================================

- Output full HTML document
- Include CSS inside <style>

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
        model: model || 'google/gemini-2.0-flash-001',
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

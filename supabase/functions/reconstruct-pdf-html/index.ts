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
Perform a complete forensic reconstruction of the provided document image and generate a pixel-accurate HTML5/CSS3 digital twin using a STRICT GRID/TABLE-BASED LAYOUT SYSTEM.

You MUST detect layout, structure, relationships, and render the final HTML in ONE PASS.

====================================================
CRITICAL MINDSET
====================================================

- The document is a VISUAL GRID SYSTEM, not free-positioned elements.
- You MUST reconstruct the page as ROWS → COLUMNS → CELLS.
- EVERY element MUST belong to exactly ONE grid cell.
- The final layout must be STABLE, NON-OVERLAPPING, and NON-DEPENDENT.

- DO NOT rely on free absolute positioning for global layout.
- DO NOT allow elements to influence each other dynamically.

====================================================
PHASE 1: GRID DETECTION & STRUCTURE RECONSTRUCTION
====================================================

STEP 1: PAGE SETUP
- Analyze image dimensions.
- Create a page container with exact width/height in px.
- Apply:
  position: relative;
  box-sizing: border-box;

----------------------------------------------------
STEP 2: ROW DETECTION
----------------------------------------------------

- Divide the page into horizontal ROWS (bands).
- Each row represents a logical content grouping.
- Rows must NOT overlap.

----------------------------------------------------
STEP 3: COLUMN DETECTION (PER ROW)
----------------------------------------------------

- Within each row, divide into COLUMNS.
- Columns must:
  - align vertically
  - not overlap
  - fully span row width

- Normalize column widths for visual consistency when appropriate.

----------------------------------------------------
STEP 4: CELL ASSIGNMENT (CRITICAL RULE)
----------------------------------------------------

- Each (row, column) intersection forms a CELL.
- EVERY detected element MUST be assigned to EXACTLY ONE cell.

STRICT RULES:
- No element may exist outside a cell.
- No element may overlap multiple cells unless using colspan/rowspan.
- Use colspan/rowspan ONLY when visually necessary.

====================================================
PHASE 2: ELEMENT ANALYSIS & CLASSIFICATION
====================================================

For each element inside a cell, detect its type:

- paragraph
- heading
- table
- chart / graph
- image / logo
- list

----------------------------------------------------
CHART / GRAPH RULE (CRITICAL)
----------------------------------------------------

- If element is a chart, graph, or diagram:
  - DO NOT extract ANY internal text (labels, legends, values)
  - Treat as a SINGLE atomic visual object
  - Replace with placeholder ONLY

Example:
<div class="artifact-placeholder">Chart</div>

----------------------------------------------------
TEXT COMPLETENESS RULE (CRITICAL)
----------------------------------------------------

- You MUST extract ALL visible text:
  - headings
  - subheadings
  - captions
  - footnotes
  - small/faint text

- Missing ANY text is a FAILURE.

----------------------------------------------------
TEXT VISIBILITY RULE
----------------------------------------------------

- Text MUST NOT be clipped or partially hidden.
- Cell height MUST expand to fully contain text.
- DO NOT cut off text using overflow.

====================================================
PHASE 3: HTML GRID RENDERING
====================================================

You MUST generate layout using a TABLE-BASED GRID:

- Use <table> as main layout container
- Use <tr> for rows
- Use <td> for columns/cells

RULES:

- Table must match page width
- Use border-collapse: collapse
- No unintended spacing

----------------------------------------------------
CELL STRUCTURE RULE
----------------------------------------------------

Inside each <td>:

- Place ONLY the content assigned to that cell
- Content must NOT overflow outside cell

----------------------------------------------------
LOCAL LAYOUT (INSIDE CELL)
----------------------------------------------------

Inside a cell, you MAY use:

- display: block
- display: flex (for inline alignment)
- minimal positioning if needed

DO NOT:
- break outside the cell
- create cross-cell dependencies

====================================================
PHASE 4: STYLING & TYPOGRAPHY
====================================================

- Use px for layout sizes
- Extract:
  - font size
  - font weight
  - color (HEX)
  - alignment

FONT RULE:
- Use closest Google Font
- Include fallback fonts

ALIGNMENT:
- Match left / center / right exactly

====================================================
PHASE 5: TABLES INSIDE CELLS
====================================================

If a detected element is a data table:

- Reconstruct using nested <table>
- Apply:
  - colspan
  - rowspan
  - borders
  - background colors
  - alignment

====================================================
PHASE 6: ARTIFACT PLACEHOLDERS
====================================================

For charts, images, logos:

Use:

<div class="artifact-placeholder">[Description]</div>

Style:
- background: #f4f4f4
- border: 1px dashed #999
- width: 100%
- height: appropriate px value

====================================================
PHASE 7: SELF-CORRECTION AUDIT
====================================================

Before output, verify:

1. GRID INTEGRITY:
- Rows and columns correctly represent layout
- No overlapping cells

2. CELL OWNERSHIP:
- Every element belongs to one cell only

3. TEXT COMPLETENESS:
- No missing text

4. CHART RULE:
- No chart internal text extracted

5. VISIBILITY:
- No clipped or hidden text

6. ALIGNMENT:
- Visual alignment matches original

7. DENSITY:
- Spacing matches original layout

====================================================
FINAL OUTPUT
====================================================

- Generate a complete HTML5 document
- Include all CSS inside <style>
- Use clean structured HTML

STRICT OUTPUT RULE:
- Output ONLY the HTML code
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

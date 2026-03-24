import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import * as docx from 'https://esm.sh/docx@8.5.0'

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

console.log("🚀 Edge Function: convert-pdf-word starting...")

serve(async (req: any) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    
    // 1. Validate User
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader || '' } } }
    )

    const { data: { user }, error: authError } = await supabaseClient.auth.getUser()
    if (authError || !user) throw new Error("Unauthorized")

    // 2. Extract Payload
    const { images, model, originalFileName } = await req.json()
    if (!images || images.length === 0) throw new Error("No images provided")

    const OPENROUTER_KEY = Deno.env.get('OPENROUTER_API_KEY')
    if (!OPENROUTER_KEY) throw new Error("API Key missing")

    // 3. AI Extraction
    const CONVERTER_PROMPT = `
You are "Antigravity", an expert Document Layout Analyzer and Spatial UI/UX Parser.
Your singular goal is to scan document images and convert them into a highly structured, precise JSON representation so they can be rebuilt flawlessly in Microsoft Word (.docx).

You will encounter a mix of Arabic (RTL) worksheets, English (LTR) technical guides, complex multi-column layouts, code snippets, and heavy infographic slides. 

CRITICAL DIRECTIVES:

1. PAGES WRAPPER
- Ensure the absolute root object contains a "pages" array so we can process multiple pages.

2. READING ORDER & COLUMNS (DO NOT MASH TEXT)
- Detect if the page uses a multi-column layout (e.g., card layouts or 2-column articles). Read column-by-column vertically.
- Output these as a "columns" block containing nested blocks.

3. TEXT & DIRECTION (RTL/LTR)
- Auto-detect the primary language.
- NEVER SUMMARIZE. Transcribe every word exactly.
- Preserve all dotted lines (.........) and empty parentheses (     ) for fill-in-the-blanks.

4. INLINE FORMATTING
- Break text inside paragraphs/headings into "runs" to capture inline bolding, italics, or specific HEX colors. 
- Estimate font size (e.g., Title=24, Heading=18, Body=12, Small=10).

5. LISTS & HIERARCHY
- Track list levels meticulously.

6. CODE BLOCKS
- Wrap SQL/Code strictly in a "code_block" type. Preserve \n line breaks.

7. TABLES & MCQ GRIDS
- Identify visible tables and INVISIBLE tables (like 2x2 multi-choice questions). 
- Represent these precisely with row and col indices.

8. IMAGES & THE "INFOGRAPHIC BAILOUT"
- Crop charts, organs, or shapes. Evaluate complex blueprint graphics as one massive "infographic_image".

STRICT JSON SCHEMA OUTPUT:
{
  "pages": [
    {
      "page_metadata": {
        "width": 1000,
        "height": 1000,
        "primary_language": "en|ar|mixed",
        "direction": "LTR|RTL"
      },
      "blocks": [
        // TYPE 1: PARAGRAPHS, HEADINGS, & LISTS
        {
          "type": "paragraph|heading|list_item",
          "alignment": "left|center|right|justify",
          "list_details": { "type": "number|bullet|letter", "level": 1, "marker": "1.|أ.|○" }, // Omit if not a list
          "runs": [
            { 
              "text": "Exact text...", 
              "style": { "bold": true|false, "italic": true|false, "color": "#HEXCODE", "size": 12 } 
            }
          ]
        },
        
        // TYPE 2: MULTI-COLUMN LAYOUTS
        {
          "type": "columns",
          "column_count": 2,
          "columns_data": [
            { "col_index": 0, "blocks": [ ] }, // Array of blocks
            { "col_index": 1, "blocks": [ ] }
          ]
        },

        // TYPE 3: TABLES & INVISIBLE GRIDS
        {
          "type": "table",
          "rows": 2,
          "columns": 2,
          "borders": true|false,
          "cells": [
            { "row": 0, "col": 0, "blocks": [ ] } // Array of blocks in cell
          ]
        },

        // TYPE 4: CODE BLOCKS
        {
          "type": "code_block",
          "language": "sql|json|javascript|unknown",
          "text": "Exact code with \\n preserved...",
          "boundingBox": [0,0,10,10]
        },

        // TYPE 5: IMAGES & INFOGRAPHICS
        {
          "type": "image|infographic_image",
          "description": "Short description of the visual",
          "boundingBox": [0,0,10,10]
        }
      ]
    }
  ]
}`;

    const aiResponse = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model || 'google/gemini-3-flash-preview',
        messages: [
          { role: 'system', content: CONVERTER_PROMPT },
          { role: 'user', content: images.map((p: any) => ({
             type: 'image_url',
             image_url: { url: `data:${p.mimeType || 'image/jpeg'};base64,${p.data}` }
          }))}
        ],
        temperature: 0.0,
        response_format: { type: "json_object" }
      })
    })

    const data = await aiResponse.json()
    if (!aiResponse.ok) throw new Error("AI Error: " + JSON.stringify(data))

    const aiContent = data.choices[0].message.content;
    const documentData = JSON.parse(aiContent);

    // 4. Build DOCX AST using Recursion
    const docChildren: any[] = [];
    
    // Recursive Block Builder
    function buildBlocks(blocks: any[], isRtl: boolean = false): any[] {
        const elements: any[] = [];
        for (const block of blocks || []) {
            
            const alignmentStr = block.alignment || 'left';
            let alignment = docx.AlignmentType.LEFT;
            if (alignmentStr === 'center') alignment = docx.AlignmentType.CENTER;
            if (alignmentStr === 'right') alignment = docx.AlignmentType.RIGHT;
            if (alignmentStr === 'justify') alignment = docx.AlignmentType.JUSTIFIED;

            const buildRuns = (runs: any[]) => {
                return (runs || []).map(run => new docx.TextRun({
                    text: run.text || "",
                    bold: run.style?.bold || false,
                    italics: run.style?.italic || false,
                    size: (run.style?.size || 12) * 2, // docx uses half-points
                    color: (run.style?.color || "000000").replace('#', ''),
                    rightToLeft: isRtl
                }));
            };

            if (block.type === 'heading') {
                const hLevel = block.level === 1 ? docx.HeadingLevel.HEADING_1 : 
                               block.level === 2 ? docx.HeadingLevel.HEADING_2 : 
                               docx.HeadingLevel.HEADING_3;
                elements.push(new docx.Paragraph({
                    children: buildRuns(block.runs),
                    heading: hLevel,
                    alignment: alignment,
                    bidirectional: isRtl,
                    spacing: { after: 120 }
                }));
            } 
            else if (block.type === 'paragraph' || block.type === 'text') {
                elements.push(new docx.Paragraph({
                    alignment: alignment,
                    spacing: { after: 120 },
                    bidirectional: isRtl,
                    children: block.runs ? buildRuns(block.runs) : [new docx.TextRun({ text: block.text || "", rightToLeft: isRtl })]
                }));
            }
            else if (block.type === 'list_item') {
                const isBullet = block.list_details?.type === 'bullet';
                elements.push(new docx.Paragraph({
                    alignment: alignment,
                    spacing: { after: 120 },
                    bidirectional: isRtl,
                    bullet: isBullet ? { level: block.list_details?.level || 0 } : undefined,
                    indent: { left: 720 }, // 0.5 inch indent for all lists
                    children: block.runs ? buildRuns(block.runs) : [new docx.TextRun({ text: block.text || "", rightToLeft: isRtl })]
                }));
            }
            else if (block.type === 'code_block') {
                elements.push(new docx.Paragraph({
                    children: [new docx.TextRun({ text: block.text || "", font: "Courier New", size: 20 })],
                    shading: { type: docx.ShadingType.CLEAR, color: "auto", fill: "F0F0F0" },
                    spacing: { before: 120, after: 120 },
                    bidirectional: false // Code is LTR
                }));
            }
            else if (block.type === 'columns') {
                const cols = block.columns_data || [];
                const tableBordersNone = {
                    top: { style: docx.BorderStyle.NONE, size: 0, color: "auto" },
                    bottom: { style: docx.BorderStyle.NONE, size: 0, color: "auto" },
                    left: { style: docx.BorderStyle.NONE, size: 0, color: "auto" },
                    right: { style: docx.BorderStyle.NONE, size: 0, color: "auto" },
                    insideHorizontal: { style: docx.BorderStyle.NONE, size: 0, color: "auto" },
                    insideVertical: { style: docx.BorderStyle.NONE, size: 0, color: "auto" }
                };

                const tableCells = cols.map((col: any) => {
                    const cellChildren = col.blocks && col.blocks.length > 0 ? buildBlocks(col.blocks, isRtl) : [new docx.Paragraph({ text: "" })];
                    return new docx.TableCell({
                        children: cellChildren,
                        borders: tableBordersNone
                    });
                });

                if (tableCells.length > 0) {
                    elements.push(new docx.Table({
                        rows: [new docx.TableRow({ children: tableCells })],
                        width: { size: 100, type: docx.WidthType.PERCENTAGE },
                        borders: tableBordersNone
                    }));
                    elements.push(new docx.Paragraph({ text: "" })); // spacer
                }
            }
            else if (block.type === 'table') {
                const maxRow = Math.max(0, ...((block.cells || []).map((c: any) => c.row || 0)));
                const maxCol = Math.max(0, ...((block.cells || []).map((c: any) => c.col || 0)));
                
                const tableBordersNone = {
                    top: { style: docx.BorderStyle.NONE, size: 0, color: "auto" },
                    bottom: { style: docx.BorderStyle.NONE, size: 0, color: "auto" },
                    left: { style: docx.BorderStyle.NONE, size: 0, color: "auto" },
                    right: { style: docx.BorderStyle.NONE, size: 0, color: "auto" },
                    insideHorizontal: { style: docx.BorderStyle.NONE, size: 0, color: "auto" },
                    insideVertical: { style: docx.BorderStyle.NONE, size: 0, color: "auto" }
                };

                const rows = [];
                for (let r = 0; r <= maxRow; r++) {
                    const rowCells = [];
                    for (let c = 0; c <= maxCol; c++) {
                        const cellData = (block.cells || []).find((x: any) => x.row === r && x.col === c);
                        const cellChildren = cellData?.blocks && cellData.blocks.length > 0 
                            ? buildBlocks(cellData.blocks, isRtl) 
                            : [new docx.Paragraph({ text: "" })];
                        
                        rowCells.push(new docx.TableCell({
                            children: cellChildren,
                            borders: block.borders === false ? tableBordersNone : undefined
                        }));
                    }
                    if (rowCells.length > 0) rows.push(new docx.TableRow({ children: rowCells }));
                }

                if (rows.length > 0) {
                    elements.push(new docx.Table({ 
                        rows, 
                        width: { size: 100, type: docx.WidthType.PERCENTAGE },
                        borders: block.borders === false ? tableBordersNone : undefined
                    }));
                    elements.push(new docx.Paragraph({ text: "" })); // spacer
                }
            }
            else if (block.type === 'image' || block.type === 'infographic_image') {
                const desc = block.description || "IMAGE OR INFOGRAPHIC PLACEHOLDER";
                elements.push(new docx.Paragraph({
                    alignment: docx.AlignmentType.CENTER,
                    children: [
                        new docx.TextRun({ text: `[ ${desc.toUpperCase()} ]`, italics: true, color: "888888" })
                    ],
                    spacing: { before: 200, after: 200 }
                }));
            }
            else {
                // CATCH-ALL
                if (block.text) {
                    elements.push(new docx.Paragraph({
                        children: [new docx.TextRun({ text: block.text, rightToLeft: isRtl })],
                        bidirectional: isRtl,
                        alignment: alignment,
                        spacing: { after: 120 }
                    }));
                } else if (block.runs) {
                    elements.push(new docx.Paragraph({
                        children: buildRuns(block.runs),
                        bidirectional: isRtl,
                        alignment: alignment,
                        spacing: { after: 120 }
                    }));
                }
            }
        }
        return elements;
    }
    
    // Process top-level pages
    for (const page of documentData.pages || []) {
      const isRtl = page.page_metadata?.direction === 'RTL';
      
      const pageElements = buildBlocks(page.blocks, isRtl);
      docChildren.push(...pageElements);
      
      docChildren.push(new docx.Paragraph({ children: [new docx.PageBreak()] }));
    }

    const doc = new docx.Document({
        creator: "E-Invoice AI Converter",
        sections: [{
            properties: {},
            children: docChildren
        }]
    });

    const b64 = await docx.Packer.toBase64String(doc);
    const buffer = Uint8Array.from(atob(b64), c => c.charCodeAt(0));

    // 5. Save to Storage
    const fileName = `${user.id}/${Date.now()}_${originalFileName || 'converted'}.docx`;
    const { data: uploadData, error: uploadError } = await supabaseClient
      .storage
      .from('conv_files')
      .upload(fileName, buffer, {
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        upsert: false
      });

    if (uploadError) throw uploadError;

    // Return the bucket path
    return new Response(JSON.stringify({ 
      success: true, 
      filePath: uploadData.path,
      message: "Successfully converted and uploaded",
      debug: {
        model: model || 'google/gemini-3-flash-preview',
        prompt: CONVERTER_PROMPT,
        rawAiOutput: documentData
      }
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (err: any) {
    console.error(err);
    return new Response(JSON.stringify({ error: err.message }), { 
      status: 500, 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    })
  }
})

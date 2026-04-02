import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.0"
import * as docx from "https://esm.sh/docx@8.5.0"

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
}

console.log("🚀 Edge Function: convert-pdf-word starting (Spatial Intelligence Mode)...")

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    const body = await req.json()
    const { images, model, originalFileName, userId: bodyUserId, spatialMetadata } = body
    
    // 1. Setup Admin Client
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // 2. Resolve User ID
    const isGuest = bodyUserId === '00000000-0000-0000-0000-000000000000';
    let finalUserId = bodyUserId || 'anonymous';
    
    if (!isGuest && authHeader && authHeader.length > 50 && !authHeader.includes('undefined')) {
      try {
          const client = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY') || '', {
              global: { headers: { Authorization: authHeader } }
          });
          const { data: { user } } = await client.auth.getUser();
          if (user) finalUserId = user.id;
      } catch (e) {
          console.warn("Auth check ignored:", e.message);
      }
    }

    if (!images || images.length === 0) throw new Error("No images provided")

    const OPENROUTER_KEY = Deno.env.get('OPENROUTER_API_KEY');
    if (!OPENROUTER_KEY) throw new Error("OPENROUTER_API_KEY missing.");

    // 4. Strong AI Prompt With Spatial Blueprint
    // We send a stripped-down version of the spatial map to save tokens
    const blueprintSummary = (spatialMetadata || []).map((p: any) => ({
        page: p.pageIndex,
        elementsCount: p.elements?.length || 0,
        // Send first 50 elements as a sample of the structure
        sample: p.elements?.slice(0, 50).map((e: any) => ({ t: e.text, x: e.x, y: e.y, f: e.font }))
    }));

    const CONVERTER_PROMPT = `
You are a High-Precision Document Architect.
INPUT: Images of a PDF + A "Spatial Blueprint" containing raw text coordinates and font names.
TASK: Reconstruct the document into a clean JSON structure that mimics the original layout exactly.
SCHEMA: { "pages": [ { "page_metadata": { "direction": "LTR|RTL" }, "blocks": [...] } ] }
BLOCK TYPES: "heading", "paragraph", "list_item", "table", "code_block".
RULES:
1. Use the Blueprint to identify columns, headers, and footer sections.
2. Group adjacent elements from the Blueprint into logical "blocks".
3. Preserve the exact text. Do not summarize.
4. If RTL (Arabic) is detected in the image or blueprint, set direction to "RTL".
BLUEPRINT SUMMARY: ${JSON.stringify(blueprintSummary)}
Output ONLY raw JSON.`;

    console.log("🤖 AI Phase (with Spatial Blueprint)...");
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
          { role: 'system', content: CONVERTER_PROMPT },
          { role: 'user', content: images.map((p: any) => ({
             type: 'image_url',
             image_url: { url: `data:${p.mimeType || 'image/jpeg'};base64,${p.data}` }
          }))}
        ],
        temperature: 0.1,
        response_format: { type: "json_object" }
      })
    });

    if (!aiResponse.ok) {
        const err = await aiResponse.text();
        throw new Error(`AI Provider Error: ${err.substring(0, 200)}`);
    }

    const aiData = await aiResponse.json();
    const documentData = JSON.parse(aiData.choices[0].message.content);

    // 5. Build DOCX
    console.log("📄 DOCX Phase...");
    const docChildren: any[] = [];

    function buildBlocks(blocks: any[], isRtl: boolean): any[] {
        const result: any[] = [];
        for (const block of blocks || []) {
            const alignmentStr = block.alignment || (isRtl ? 'right' : 'left');
            let alignment = docx.AlignmentType.LEFT;
            if (alignmentStr === 'center') alignment = docx.AlignmentType.CENTER;
            if (alignmentStr === 'right') alignment = docx.AlignmentType.RIGHT;

            const buildRuns = (runs: any[]) => {
                if (!runs || runs.length === 0) return [];
                return runs.map((run: any) => new docx.TextRun({
                    text: run.text || "",
                    bold: !!run.style?.bold,
                    size: (run.style?.size || 11) * 2,
                    rightToLeft: isRtl,
                    font: run.style?.font || undefined,
                    color: run.style?.color || undefined
                }));
            };

            const runs = block.runs && block.runs.length > 0 
                ? buildRuns(block.runs) 
                : (block.text ? [new docx.TextRun({ text: block.text, rightToLeft: isRtl })] : []);

            if (runs.length > 0) {
                const isBullet = block.type === 'list_item';
                result.push(new docx.Paragraph({
                    children: runs,
                    alignment,
                    bidirectional: isRtl,
                    bullet: isBullet ? { level: 0 } : undefined,
                    spacing: { after: 120 }
                }));
            }
        }
        return result;
    }
    
    for (const page of documentData.pages || []) {
        const isRtl = page.page_metadata?.direction === 'RTL';
        docChildren.push(...buildBlocks(page.blocks, isRtl));
        docChildren.push(new docx.Paragraph({ children: [new docx.PageBreak()] }));
    }

    const doc = new docx.Document({ sections: [{ children: docChildren }] });
    const buffer = await docx.Packer.toBuffer(doc);

    // 6. Save to Storage
    const safeBaseName = (originalFileName || 'file').replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const fileName = `${finalUserId}/${Date.now()}_${safeBaseName}.docx`;
    const { data: uploadData, error: uploadError } = await supabaseAdmin
      .storage
      .from('conv_files')
      .upload(fileName, buffer, {
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        upsert: true
      });

    if (uploadError) throw uploadError;

    return new Response(JSON.stringify({ 
      success: true, 
      filePath: uploadData.path,
      message: "Stage 2 Successful!",
      debug: { 
        blueprintUsed: !!spatialMetadata,
        pageCount: documentData.pages?.length || 0 
      }
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

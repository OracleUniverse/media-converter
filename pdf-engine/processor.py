import fitz  # PyMuPDF
import os
import json
import io
import base64
from docx import Document
from docx.shared import Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.oxml import OxmlElement
from openai import OpenAI
from docx.shared import Inches, Pt, RGBColor

# Helper to force RTL Bidi in python-docx paragraphs
def set_rtl(p):
    pPr = p._p.get_or_add_pPr()
    bidi = OxmlElement('w:bidi')
    pPr.append(bidi)

def get_rgb(color_val):
    if isinstance(color_val, str) and color_val.startswith("#"):
        c = color_val.lstrip("#")
        try:
            return (int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16))
        except:
            pass
    return 0, 0, 0

class PDFProcessor:
    def __init__(self, api_key: str):
        if not api_key:
            raise ValueError("❌ OPENROUTER_API_KEY is missing. Please set it in pdf-engine/.env")
        
        self.client = OpenAI(
            base_url="https://openrouter.ai/api/v1",
            api_key=api_key
        )

    def extract_layout_and_images(self, pdf_bytes: bytes) -> list[dict]:
        """Stage 1: Render 1K resolution image at 1.0 scale, without PyMuPDF text metadata."""
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        pages: list[dict] = []

        for page in doc:
            # Render image at 1.0 scale and 200 DPI for high quality AI scanning
            mat = fitz.Matrix(1.0, 1.0)
            pix = page.get_pixmap(matrix=mat, dpi=200)
            img_b64 = base64.b64encode(pix.tobytes("jpeg")).decode("utf-8")

            pages.append({
                "page": page.number + 1,
                "image_base64": img_b64
            })

        return pages

    def get_ai_reconstruction(self, pages: list[dict]) -> dict:
        """Stage 2: Gemini natively generates a Structured JSON Document AST."""
        json_pages = []
        raw_responses = []

        for p in pages:
            prompt_text = f"""You are a Lead Document Architect. Your mission is to reconstruct a PDF page into a high-fidelity, Word-compatible Structured JSON AST (Abstract Syntax Tree) that accounts for text, images, and complex document objects.

Analyze the attached image of Page {p['page']} with a GRAPHICS-FIRST mindset.

Fidelity Laws:
1. ONLY extract elements visibly present on the attached image. Forget all other pages.
2. GRAPHICS AUDIT: If you see a collections of lines, legend labels, or bars (BAR CHART, PIE CHART, GRAPH), label it as `type: "image"` and provide its exact bounding box. DO NOT ignore charts.
3. Every single element (paragraphs, tables, images) MUST have a bounding box: `[ymin, xmin, ymax, xmax]` representing normalized 0-1000 screen positions.
4. ORDER: Assign `order: 1, 2, 3...` strictly by reading flow (top-to-bottom, right-to-left for Arabic).

Typography & Alignment Rules:
- Detect text alignment strictly: 'left', 'center', 'right', 'justify'. Right-to-Left (RTL) Arabic text MUST be marked as 'right'.
- Include specific "style" attributes for text blocks: fontSize (pt), bold (true/false), color (HEX).

Output Format (Strict JSON ONLY):
Return exactly this schema and nothing else:
{{
  "blocks": [
    {{
      "type": "paragraph",
      "text": "The extracted original text exactly as written...",
      "order": 1,
      "style": {{"fontSize": 12, "bold": false, "color": "#000000"}},
      "alignment": "right",
      "bbox": [50, 800, 100, 950]
    }},
    {{
      "type": "table",
      "order": 2,
      "rows": [
        [
          {{"text": "Cell text", "style": {{"bold": true, "fontSize": 12}}}}
        ]
      ],
      "columnWidths": [50, 50], // Percentage weights
      "bbox": [150, 100, 400, 950]
    }},
    {{
      "type": "image",
      "id": "p{p['page']}_img_1",
      "order": 3,
      "description": "Chart/Image description",
      "bbox": [500, 200, 700, 800]
    }}
  ]
}}"""
            
            image_part = {
                "type": "image_url",
                "image_url": {"url": f"data:image/jpeg;base64,{p['image_base64']}"}
            }

            response = self.client.chat.completions.create(
                model="google/gemini-2.0-flash-001",
                messages=[{"role": "user", "content": [{"type": "text", "text": prompt_text}, image_part]}],
                response_format={"type": "json_object"}
            )
            
            content = response.choices[0].message.content
            # Quick structural JSON repair in case of backticks leaking despite instruction
            content = content.replace("```json", "").replace("```", "").strip()
            
            ai_result = json.loads(content)
            
            # Sort blocks by 'order' or strictly by ymin to prevent layout confusion if ai misses order
            blocks = ai_result.get("blocks", [])
            try:
                blocks.sort(key=lambda b: (b.get("order", 999), b.get("bbox", [0])[0] if b.get("bbox") else 0))
            except:
                pass
            
            json_pages.append(blocks)
            
            raw_responses.append({
                "page": p["page"],
                "recognition": ai_result
            })

        return {"json_pages": json_pages, "raw_responses": raw_responses}

    def crop_images(self, pdf_bytes: bytes, reconstruction: dict) -> dict:
        """Post-Process Phase: Crop bounding boxes derived from AI natively into PyMuPDF pngs."""
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        os.makedirs("/tmp/pdf_images", exist_ok=True)
        
        for raw_resp in reconstruction.get("raw_responses", []):
            page_num = raw_resp["page"]
            if page_num - 1 >= len(doc): continue
            page = doc[page_num - 1]
            pdf_w = page.rect.width
            pdf_h = page.rect.height
            
            ai_data = raw_resp.get("recognition", {})
            blocks = ai_data.get("blocks", [])
            for obj in blocks:
                if obj.get("type") == "image" and "bbox" in obj:
                    try:
                        ymin, xmin, ymax, xmax = obj["bbox"]
                        # Convert normalized 0-1000 coordiantes to PyMuPDF native pt scale
                        y0 = (ymin / 1000) * pdf_h
                        x0 = (xmin / 1000) * pdf_w
                        y1 = (ymax / 1000) * pdf_h
                        x1 = (xmax / 1000) * pdf_w
                        
                        # Apply 5px padding constraint
                        padding = 5
                        y0 = max(0, y0 - padding)
                        x0 = max(0, x0 - padding)
                        y1 = min(pdf_h, y1 + padding)
                        x1 = min(pdf_w, x1 + padding)
                        
                        crop_rect = fitz.Rect(x0, y0, x1, y1)
                        # Render at 3x scale for extremely crisp DOCX output
                        pix = page.get_pixmap(clip=crop_rect, matrix=fitz.Matrix(3, 3))
                        img_path = f"/tmp/pdf_images/{obj['id']}.png"
                        pix.save(img_path)
                    except Exception as e:
                        print(f"Error extracting image {obj.get('id', 'Unknown')}: {e}")
                        
        doc.close()
        return reconstruction

    def _apply_style_to_run(self, run, style_dict):
        """Apply parsed JSON style dictionary directly to a python-docx text run."""
        if not style_dict:
            return

        if style_dict.get("bold") is True:
            run.bold = True
            bCs = OxmlElement('w:bCs')
            run._r.get_or_add_rPr().append(bCs)
            
        f_size = style_dict.get("fontSize", 12)
        try:
            f_size = float(f_size)
            run.font.size = Pt(f_size)
            szCs = OxmlElement('w:szCs')
            szCs.set(qn('w:val'), str(int(f_size * 2)))
            run._r.get_or_add_rPr().append(szCs)
        except:
            pass
        
        color_val = style_dict.get("color", "#000000")
        r, g, b = get_rgb(color_val)
        run.font.color.rgb = RGBColor(r, g, b)
        
        run.font.rtl = True # Fix Arabic punctuation logic natively

    def _apply_alignment(self, paragraph, align_str):
        if align_str == 'right':
            paragraph.alignment = WD_ALIGN_PARAGRAPH.RIGHT
        elif align_str == 'center':
            paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
        elif align_str == 'justify':
            paragraph.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        else:
            paragraph.alignment = WD_ALIGN_PARAGRAPH.LEFT

    def build_docx(self, reconstruction: dict) -> bytes:
        """Stage 3: Directly map JSON AST payload into native python-docx tree with BBOX spacing."""
        doc = Document()
        json_pages = reconstruction.get("json_pages", [])
        
        # Standard page height in pts for layout calculation (A4/Letter ~ 792 pts)
        PAGE_HEIGHT_PTS = 792.0
        USABLE_WIDTH_INCHES = 6.0

        for page_idx, page_blocks in enumerate(json_pages):
            # Create a New Section for each page to prevent drift
            if page_idx > 0:
                new_section = doc.add_section()
                new_section.start_type = 2 # New Page

            last_ymax = 0 # Track previous block's bottom in normalized units (0-1000)

            for block in page_blocks:
                b_type = block.get("type", "paragraph")
                bbox = block.get("bbox") or [0, 0, 0, 0]
                ymin, xmin, ymax, xmax = bbox
                
                # Calculate required padding to reach current block from last block
                # normalized_gap = ymin - last_ymax
                # point_spacing = (normalized_gap / 1000) * PAGE_HEIGHT_PTS
                # For high fidelity, we use a safe margin approach
                space_before = Pt(max(2, ((ymin - last_ymax) / 1000) * PAGE_HEIGHT_PTS))
                
                if b_type in ["paragraph", "heading"]:
                    text = (block.get("text") or "").strip()
                    if not text: continue
                    
                    p = doc.add_paragraph()
                    p.paragraph_format.space_before = space_before
                    p.paragraph_format.line_spacing = 1.0
                    p.paragraph_format.space_after = Pt(0)
                    
                    align_str = block.get("alignment", "right") 
                    self._apply_alignment(p, align_str)
                    
                    if align_str == "right":
                        set_rtl(p)
                    
                    run = p.add_run(text)
                    self._apply_style_to_run(run, block.get("style") or {})
                
                elif b_type == "list":
                    text = (block.get("text") or "").strip()
                    if not text: continue
                    
                    p = doc.add_paragraph()
                    p.paragraph_format.space_before = space_before
                    p.paragraph_format.space_after = Pt(0)
                    self._apply_alignment(p, block.get("alignment", "right"))
                    p.style = "List Bullet"
                    
                    set_rtl(p)
                    run = p.add_run(text)
                    self._apply_style_to_run(run, block.get("style") or {})

                elif b_type == "image":
                    img_id = block.get("id", "")
                    local_path = f"/tmp/pdf_images/{img_id}.png"
                    if os.path.exists(local_path):
                        p = doc.add_paragraph()
                        p.paragraph_format.space_before = space_before
                        p.paragraph_format.space_after = Pt(0)
                        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                        run = p.add_run()
                        
                        norm_width = xmax - xmin
                        dynamic_width = Inches((norm_width / 1000) * USABLE_WIDTH_INCHES)
                        run.add_picture(local_path, width=max(Inches(0.5), dynamic_width))

                elif b_type == "table":
                    rows = block.get("rows", [])
                    col_widths = block.get("columnWidths", [])
                    if not rows: continue
                    
                    cols_count = max([len(r) for r in rows]) if rows else 0
                    if cols_count == 0: continue
                    
                    # Add spacer paragraph before the table to reach ymin
                    spacer = doc.add_paragraph()
                    spacer.paragraph_format.space_before = space_before
                    spacer.paragraph_format.space_after = Pt(0)
                    
                    table = doc.add_table(rows=len(rows), cols=cols_count)
                    table.style = 'Table Grid'
                    table.autofit = False # Lock widths
                    table.table_direction = "rtl"
                    
                    # Proportional mapping
                    if col_widths and len(col_widths) == cols_count:
                        for i, width_pct in enumerate(col_widths):
                            for row in table.rows:
                                row.cells[i].width = Inches((width_pct / 100) * USABLE_WIDTH_INCHES)
                    
                    for r_idx, r_data in enumerate(rows):
                        for c_idx, cell_data in enumerate(r_data):
                            if c_idx < cols_count:
                                cell = table.cell(r_idx, c_idx)
                                cp = cell.paragraphs[0]
                                cp.paragraph_format.space_after = Pt(0)
                                set_rtl(cp)
                                cp.alignment = WD_ALIGN_PARAGRAPH.RIGHT
                                text = (cell_data.get("text") or "").strip()
                                run = cp.add_run(text)
                                self._apply_style_to_run(run, cell_data.get("style") or {})

                last_ymax = ymax # Update tracking

        buffer = io.BytesIO()
        doc.save(buffer)
        buffer.seek(0)
        return buffer.read()

    def build_html(self, json_pages: list) -> list[str]:
        """Proxy compiler to render visual HTML output requested by Frontend"""
        html_pages = []
        for page_blocks in json_pages:
            html = "<div dir='rtl' style='padding: 20px; font-family: Arial;'>"
            for block in page_blocks:
                b_type = block.get("type", "paragraph")
                style = block.get("style") or {}
                
                # convert style to css
                css = []
                if style.get("bold"): css.append("font-weight: bold;")
                if style.get("color"): css.append(f"color: {style['color']};")
                if style.get("fontSize"): css.append(f"font-size: {style['fontSize']}pt;")
                
                align = block.get("alignment", "right")
                css.append(f"text-align: {align};")
                
                style_str = " ".join(css)
                text = block.get("text") or ""
                
                if b_type in ["paragraph", "heading"]:
                    html += f"<p style='{style_str}'>{text}</p>\\n"
                elif b_type == "list":
                    html += f"<ul style='{style_str}'><li>{text}</li></ul>\\n"
                elif b_type == "image":
                    img_id = block.get("id", "")
                    html += f"<div style='text-align: center; margin: 10px;'><img src='{img_id}.png' alt='Image {img_id}' style='max-width: 100%; border: 1px dashed #ccc;'/></div>\\n"
                elif b_type == "table":
                    html += "<table border='1' style='width: 100%; border-collapse: collapse; margin-top: 10px;'>"
                    for row in block.get("rows", []):
                        html += "<tr>"
                        for cell in row:
                            cell_text = cell.get("text") or ""
                            cell_style = cell.get("style") or {}
                            c_css = ""
                            if cell_style.get("bold"): c_css += "font-weight: bold;"
                            html += f"<td style='padding: 5px; {c_css}'>{cell_text}</td>"
                        html += "</tr>"
                    html += "</table>\\n"
                    
            html += "</div>"
            html_pages.append(html)
        return html_pages

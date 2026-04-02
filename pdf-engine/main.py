import os
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from processor import PDFProcessor
import base64
from dotenv import load_dotenv

load_dotenv()

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configuration
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")
processor = PDFProcessor(api_key=OPENROUTER_API_KEY)

@app.get("/")
async def root():
    return {"status": "Python PDF Engine Active", "mode": "PyMuPDF + Gemini 2.0"}

@app.post("/convert")
async def convert_pdf(file: UploadFile = File(...)):
    if not file.filename.endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported")

    try:
        pdf_bytes = await file.read()
        
        # Stage 1: PyMuPDF extracts full layout metadata + images
        print(f"🖼️  Extracting metadata and images for: {file.filename}")
        pages = processor.extract_layout_and_images(pdf_bytes)
        
        # Stage 2: AI extracts ALL text + detects tables/lists applying metadata
        print(f"🤖 AI Vision analyzing {len(pages)} page(s) with Multi-Pass Pipeline...")
        reconstruction = processor.get_ai_reconstruction(pages, pdf_bytes)
        
        # Pre-Stage 3: Extract and Crop Images using PyMuPDF and AI Bounding Boxes
        print("🖼️ Cropping detected images natively from AI Bounding Boxes...")
        reconstruction = processor.crop_images(pdf_bytes, reconstruction)

        # Stage 3: Build the final Word document
        print("📄 Assemble final Word document...")
        docx_bytes = processor.build_docx(reconstruction)
        
        encoded_content = base64.b64encode(docx_bytes).decode("utf-8")
        
        # Compile full HTML string for download via the AST proxy compiler
        html_pages_list = processor.build_html(reconstruction.get("json_pages", []))
        full_html = "\n<br><hr style='page-break-after: always;'/><br>\n".join(html_pages_list)
        encoded_html = base64.b64encode(full_html.encode("utf-8")).decode("utf-8")

        return {
            "success": True,
            "filename": f"{file.filename.replace('.pdf', '')}_converted.docx",
            "content": encoded_content,
            "html_filename": f"{file.filename.replace('.pdf', '')}_converted.html",
            "html_content": encoded_html,
            "debug": {
                "pages": len(pages),
                "html_pages": len(reconstruction.get("html_pages", [])),
                "model": "google/gemini-2.0-flash-001 (via OpenRouter)",
                "rawAiOutput": reconstruction.get("raw_responses", [])
            }
        }

    except Exception as e:
        print(f"❌ Conversion Error: {str(e)}")
        return {
            "success": False, 
            "error": str(e)
        }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

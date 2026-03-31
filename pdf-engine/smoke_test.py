import os
from processor import PDFProcessor
from dotenv import load_dotenv

load_dotenv()

# Basic smoke test for instantiation
api_key = os.getenv("OPENROUTER_API_KEY")
if not api_key:
    print("❌ OPENROUTER_API_KEY not found in .env")
else:
    try:
        proc = PDFProcessor(api_key=api_key)
        print("✅ PDFProcessor instantiated successfully.")
    except Exception as e:
        print(f"❌ Error: {e}")

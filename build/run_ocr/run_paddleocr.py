
import sys
from paddleocr import PaddleOCR
import json

def run_ocr(image_path):
    try:
        ocr = PaddleOCR(use_angle_cls=True, lang='en')
        result = ocr.ocr(image_path, cls=True)
        return result
    except Exception as e:
        return {"error": str(e)}

if __name__ == "__main__":
    image_path = sys.argv[1]
    result = run_ocr(image_path)
    print(json.dumps(result))

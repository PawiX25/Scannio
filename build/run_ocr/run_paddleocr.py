import sys
from paddleocr import PaddleOCR
import json
import numpy as np
import os

def run_ocr(image_path):
    try:
        ocr = PaddleOCR(use_angle_cls=True, lang='en')
        try:
            result = ocr.ocr(image_path, cls=True)
        except TypeError:
            result = ocr.ocr(image_path)
        return result
    except Exception as e:
        return {"error": str(e)}

def _default(o):
    if isinstance(o, np.ndarray):
        return o.tolist()
    return str(o)

if __name__ == "__main__":
    image_path = sys.argv[1]
    result = run_ocr(image_path)
    print(json.dumps(result, default=_default))
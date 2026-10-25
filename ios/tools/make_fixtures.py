"""Test photos: crop each downloaded portrait around the face and scale it to 360 px wide.
python make_fixtures.py <yunet.onnx> <downloaded photos dir> <FaceKit/Tests/FaceKitTests/Fixtures>"""
import os, sys
import cv2

yunet, src_dir, out_dir = sys.argv[1:4]
os.makedirs(out_dir, exist_ok=True)
det = cv2.FaceDetectorYN.create(yunet, '', (320, 320), 0.8, 0.3, 5000)
for name in sorted(f for f in os.listdir(src_dir) if f.endswith('.jpg')):
    img = cv2.imread(os.path.join(src_dir, name))
    h, w = img.shape[:2]
    det.setInputSize((w, h))
    _, faces = det.detect(img)
    x, y, fw, fh = max(faces, key=lambda f: f[2] * f[3])[:4]
    # Head and shoulders, the face about 40 % of the width, like a phone camera at arm's length.
    cx, cy, side = x + fw / 2, y + fh / 2, max(fw, fh) * 2.5
    x0, y0 = int(max(0, cx - side / 2)), int(max(0, cy - side / 2))
    x1, y1 = int(min(w, cx + side / 2)), int(min(h, cy + side * 0.6))
    crop = img[y0:y1, x0:x1]
    small = cv2.resize(crop, (360, int(round(crop.shape[0] * 360 / crop.shape[1]))), interpolation=cv2.INTER_AREA)
    cv2.imwrite(os.path.join(out_dir, name), small, [cv2.IMWRITE_JPEG_QUALITY, 90])
    print(name, small.shape)

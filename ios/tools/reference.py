"""Reference numbers for the FaceKit tests (run on a PC, not in CI).

OpenCV YuNet finds the five points; our own similarity fit + bilinear warp (the same maths as
FaceKit/FaceAligner.swift) cuts the 112x112 face; SFace runs in onnxruntime. Also checks that our
crop gives the same embedding as OpenCV's own FaceRecognizerSF.alignCrop + feature.

  pip install numpy opencv-python onnxruntime
  python reference.py <sface.onnx> <yunet.onnx> <fixtures dir>
writes <fixtures dir>/reference.json and prints the cosine between every pair of photos.
"""
import json, os, sys
import numpy as np

TEMPLATE = np.array([[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]])
STRIDE, SAMPLES = 997, 37


def similarity(src, dst=TEMPLATE):
    """Least-squares rotation + uniform scale + translation (no mirror), dst ≈ A·src + t, as a 2x3 matrix."""
    ms, md = src.mean(0), dst.mean(0)
    s, d = src - ms, dst - md
    den = (s ** 2).sum()
    a = (s[:, 0] * d[:, 0] + s[:, 1] * d[:, 1]).sum() / den
    b = (s[:, 0] * d[:, 1] - s[:, 1] * d[:, 0]).sum() / den
    A = np.array([[a, -b], [b, a]])
    return np.hstack([A, (md - A @ ms)[:, None]])


def warp(rgb, M, size=112):
    """Inverse-mapped bilinear warp, outside = 0 (cv2.warpAffine INTER_LINEAR / BORDER_CONSTANT convention)."""
    Ai = np.linalg.inv(M[:, :2])
    h, w = rgb.shape[:2]
    ys, xs = np.mgrid[0:size, 0:size]
    sx, sy = Ai @ np.stack([xs.ravel() - M[0, 2], ys.ravel() - M[1, 2]])
    x0, y0 = np.floor(sx).astype(int), np.floor(sy).astype(int)
    fx, fy = sx - x0, sy - y0
    img = rgb.astype(np.float32)

    def px(x, y):
        ok = (x >= 0) & (x < w) & (y >= 0) & (y < h)
        v = np.zeros((x.size, 3), np.float32)
        v[ok] = img[y[ok], x[ok]]
        return v

    v = (px(x0, y0) * ((1 - fx) * (1 - fy))[:, None] + px(x0 + 1, y0) * (fx * (1 - fy))[:, None]
         + px(x0, y0 + 1) * ((1 - fx) * fy)[:, None] + px(x0 + 1, y0 + 1) * (fx * fy)[:, None])
    return v.reshape(size, size, 3)


def unit(v):
    v = np.asarray(v, np.float64).ravel()
    return v / np.linalg.norm(v)


def main(sface, yunet, folder):
    import cv2  # only here: convert_sface.py imports the maths above without OpenCV
    import onnxruntime as ort
    det = cv2.FaceDetectorYN.create(yunet, '', (320, 320), 0.8, 0.3, 5000)
    rec = cv2.FaceRecognizerSF.create(sface, '')
    quiet = ort.SessionOptions()
    quiet.log_severity_level = 3  # the exporter listed the weights as inputs too: harmless warnings
    sess = ort.InferenceSession(sface, quiet, providers=['CPUExecutionProvider'])
    name_in = sess.get_inputs()[0].name
    out = {}
    for name in sorted(f for f in os.listdir(folder) if f.endswith('.jpg')):
        bgr = cv2.imread(os.path.join(folder, name))
        h, w = bgr.shape[:2]
        det.setInputSize((w, h))
        _, faces = det.detect(bgr)
        face = max(faces, key=lambda f: f[2] * f[3])
        pts = face[4:14].reshape(5, 2).astype(np.float64)
        eyes, mouth = sorted(pts[0:2].tolist()), sorted(pts[3:5].tolist())
        five = np.array([eyes[0], eyes[1], pts[2].tolist(), mouth[0], mouth[1]])
        crop = warp(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB), similarity(five))
        blob = np.ascontiguousarray(crop.transpose(2, 0, 1)[None], np.float32)
        own = unit(sess.run(None, {name_in: blob})[0])
        ref = unit(rec.feature(rec.alignCrop(bgr, face)))
        print(f'{name}: cos(our crop, OpenCV alignCrop+feature) = {own @ ref:.5f}')
        out[name] = {'size': [w, h], 'landmarks': five.round(4).tolist(),
                     'embedding': [round(float(x), 6) for x in own], 'opencv': [round(float(x), 6) for x in ref],
                     'blob_mean': [round(float(blob[0, c].mean()), 4) for c in range(3)],
                     'blob_sample': [round(float(x), 3) for x in blob.ravel()[::STRIDE][:SAMPLES]], 'blob_stride': STRIDE}
    names = list(out)
    print('\ncosine between photos:')
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            print(f'  {a} vs {b}: {np.dot(out[a]["embedding"], out[b]["embedding"]):.3f}')
    with open(os.path.join(folder, 'reference.json'), 'w') as f:
        json.dump(out, f, indent=1)


if __name__ == '__main__':
    main(*sys.argv[1:4])

# Tools for the kiosk app's face model

Run on a PC with Python 3 (`pip install numpy opencv-python onnxruntime`), models from OpenCV Zoo:
`face_recognition_sface_2021dec.onnx` (SFace, Apache-2.0) and `face_detection_yunet_2023mar.onnx` (YuNet, MIT).

1. `make_fixtures.py <yunet.onnx> <photos> ../FaceKit/Tests/FaceKitTests/Fixtures` — crops the public-domain
   portraits listed in `Fixtures/SOURCES.md` to 360 px wide test photos.
2. `reference.py <sface.onnx> <yunet.onnx> ../FaceKit/Tests/FaceKitTests/Fixtures` — writes `reference.json`
   (YuNet five points, aligned-crop statistics, SFace embeddings) used by `swift test`, and checks that our own
   alignment gives OpenCV's `FaceRecognizerSF` embedding (cosine ≥ 0.9999 on every photo).
3. `convert_sface.py <sface.onnx> ../ChamCong/Resources/SFace.mlmodel ../FaceKit/Tests/FaceKitTests/Fixtures`
   — ONNX → PyTorch → Core ML (float16 weights) and the Core ML vs onnxruntime check. Needs macOS for Core ML;
   the CI workflow runs it when the model file is missing (`--torch-only` checks just the PyTorch step anywhere).
4. `make_icon.py <public/icon-512.png> ../ChamCong/Resources/Assets.xcassets/AppIcon.appiconset/icon-1024.png`.

Measured with this pipeline (YuNet points → our warp → SFace), LFW 3000 same / 3000 different pairs:

| cosine threshold | same person accepted | different people accepted |
| --- | --- | --- |
| 0.363 (OpenCV default) | 98.4 % | 0.067 % (2) |
| 0.40 | 97.6 % | 0.033 % (1) |
| 0.42 | 96.8 % | 0 |
| 0.45 | 95.3 % | 0 |
| 0.50 | 91.2 % | 0 |

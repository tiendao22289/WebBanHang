# Third-party parts of the "Chấm công" iPhone app

## SFace face recognition model

- File: `ChamCong/Resources/SFace.mlmodel` — Core ML conversion (float16 weights) of
  `face_recognition_sface_2021dec.onnx` from OpenCV Zoo
  (https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface).
- ONNX sha256: `0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79` (checked by `tools/convert_sface.py`).
- License: **Apache License 2.0** (the `LICENSE` file next to the model in OpenCV Zoo).
- Credits: SFace by Yaoyao Zhong et al. ("SFace: Sigmoid-Constrained Hypersphere Loss for Robust Face
  Recognition", https://arxiv.org/abs/2205.12010); ONNX conversion by Chengrui Wang for OpenCV Zoo.
- Changes: converted ONNX → PyTorch (onnx2torch) → Core ML neural network, weights stored as float16.

## YuNet face detector (tools only, not in the app)

`tools/reference.py` uses `face_detection_yunet_2023mar.onnx` from OpenCV Zoo (MIT License,
Copyright (c) 2020 Shiqi Yu) on a PC to make the test reference numbers. The app itself finds faces
with Apple's Vision framework.

## Test photos

`FaceKit/Tests/FaceKitTests/Fixtures/*.jpg` are public-domain NASA portraits; sources in
`FaceKit/Tests/FaceKitTests/Fixtures/SOURCES.md`.

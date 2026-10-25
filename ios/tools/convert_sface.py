"""OpenCV Zoo SFace (ONNX, Apache-2.0) → Core ML for the kiosk app. Core ML needs macOS (the CI runner).

  pip install numpy onnx onnxruntime onnx2torch torch coremltools pillow
  python convert_sface.py <face_recognition_sface_2021dec.onnx> <out SFace.mlmodel> <fixtures dir> [--torch-only]

Steps: check the ONNX file's sha256 → drop the weights the exporter also listed as graph inputs →
ONNX → PyTorch (onnx2torch) → TorchScript → Core ML neural network with float16 weights →
compare with onnxruntime on random crops and on the fixture crops (cosine must be ≥ 0.999).
"""
import hashlib, json, os, sys
import numpy as np
import onnx
import onnxruntime as ort
import torch
from onnx2torch import convert

SHA256 = '0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79'
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from reference import similarity, warp  # noqa: E402


def unit(v):
    v = np.asarray(v, np.float64).ravel()
    return v / np.linalg.norm(v)


def fixture_inputs(folder):
    from PIL import Image
    refs = json.load(open(os.path.join(folder, 'reference.json')))
    out = []
    for name, ref in sorted(refs.items()):
        rgb = np.asarray(Image.open(os.path.join(folder, name)).convert('RGB'))
        crop = warp(rgb, similarity(np.array(ref['landmarks'])))
        out.append((name, np.ascontiguousarray(crop.transpose(2, 0, 1)[None], np.float32)))
    return out


def main(onnx_path, out_path, fixtures, torch_only=False):
    data = open(onnx_path, 'rb').read()
    if hashlib.sha256(data).hexdigest() != SHA256:
        raise SystemExit('unexpected SFace ONNX file (sha256 mismatch)')
    model = onnx.load_from_string(data)
    inits = {i.name for i in model.graph.initializer}
    keep = [i for i in model.graph.input if i.name not in inits]
    del model.graph.input[:]
    model.graph.input.extend(keep)
    onnx.checker.check_model(model)

    quiet = ort.SessionOptions()
    quiet.log_severity_level = 3
    sess = ort.InferenceSession(model.SerializeToString(), quiet, providers=['CPUExecutionProvider'])
    in_name = sess.get_inputs()[0].name
    rng = np.random.default_rng(7)
    inputs = [(f'random{i}', rng.uniform(0, 255, (1, 3, 112, 112)).astype(np.float32)) for i in range(3)] + fixture_inputs(fixtures)
    expected = {name: unit(sess.run(None, {in_name: x})[0]) for name, x in inputs}

    net = convert(model).eval()
    with torch.no_grad():
        for name, x in inputs:
            c = unit(net(torch.from_numpy(x)).numpy()) @ expected[name]
            print(f'torch vs onnx {name}: {c:.6f}')
            assert c > 0.9999, name
        traced = torch.jit.trace(net, torch.from_numpy(inputs[0][1]))
    if torch_only:
        return

    import coremltools as ct
    from coremltools.models.neural_network import quantization_utils
    ml = ct.convert(traced, convert_to='neuralnetwork',
                    inputs=[ct.TensorType(name='data', shape=(1, 3, 112, 112), dtype=np.float32)],
                    outputs=[ct.TensorType(name='embedding')])
    ml = quantization_utils.quantize_weights(ml, nbits=16)
    ml.author = 'Yaoyao Zhong (SFace), ONNX by OpenCV Zoo; converted for ChamCong'
    ml.license = 'Apache-2.0'
    ml.short_description = 'SFace face recognition (face_recognition_sface_2021dec): 112x112 RGB 0-255 NCHW -> 128-d embedding'
    ml.version = 'sface-2021dec'
    ml.save(out_path)
    loaded = ct.models.MLModel(out_path, compute_units=ct.ComputeUnit.CPU_ONLY)
    worst = 1.0
    for name, x in inputs:
        c = unit(loaded.predict({'data': x})['embedding']) @ expected[name]
        worst = min(worst, c)
        print(f'core ml vs onnx {name}: {c:.6f}')
    print(f'worst {worst:.6f}; size {os.path.getsize(out_path) / 1e6:.1f} MB')
    assert worst >= 0.999, 'Core ML model differs from ONNX'


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    main(*args, torch_only='--torch-only' in sys.argv)

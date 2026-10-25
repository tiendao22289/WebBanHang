"""App icon: public/icon-512.png (a 640 px JPEG) → 1024 px PNG without transparency.
python make_icon.py <public/icon-512.png> <AppIcon.appiconset/icon-1024.png>"""
import sys
import cv2

img = cv2.imread(sys.argv[1], cv2.IMREAD_COLOR)
cv2.imwrite(sys.argv[2], cv2.resize(img, (1024, 1024), interpolation=cv2.INTER_CUBIC), [cv2.IMWRITE_PNG_COMPRESSION, 9])

"""Read only active display geometry; no screenshots, windows, EDID, or serials."""
import ctypes as C
import json


class Point(C.Structure):
    _fields_ = [('x', C.c_double), ('y', C.c_double)]


class Size(C.Structure):
    _fields_ = [('width', C.c_double), ('height', C.c_double)]


class Rect(C.Structure):
    _fields_ = [('origin', Point), ('size', Size)]


def read_displays():
    cg = C.CDLL('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
    cg.CGGetActiveDisplayList.argtypes = [C.c_uint32, C.POINTER(C.c_uint32), C.POINTER(C.c_uint32)]
    cg.CGGetActiveDisplayList.restype = C.c_int
    cg.CGDisplayBounds.argtypes = [C.c_uint32]
    cg.CGDisplayBounds.restype = Rect
    cg.CGMainDisplayID.argtypes = []
    cg.CGMainDisplayID.restype = C.c_uint32
    cg.CGDisplayIsBuiltin.argtypes = [C.c_uint32]
    cg.CGDisplayIsBuiltin.restype = C.c_uint32
    ids = (C.c_uint32 * 17)()
    count = C.c_uint32()
    if cg.CGGetActiveDisplayList(17, ids, C.byref(count)) != 0 or not 1 <= count.value <= 16:
        raise RuntimeError('Display information is unavailable.')
    main = cg.CGMainDisplayID()
    displays = []
    for display_id in ids[:count.value]:
        bounds = cg.CGDisplayBounds(display_id)
        displays.append({
            'id': str(display_id),
            'isMain': display_id == main,
            'isBuiltin': bool(cg.CGDisplayIsBuiltin(display_id)),
            'x': bounds.origin.x, 'y': bounds.origin.y,
            'width': bounds.size.width, 'height': bounds.size.height,
        })
    return displays


if __name__ == '__main__':
    print(json.dumps(read_displays(), allow_nan=False, separators=(',', ':')))

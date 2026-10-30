"""Micro Plus preset decoding and protobuf wire encoding.

Schemas: spod/fmmp/protobuf/ltx. Transport framing: Maneline's Tone captures.
"""
import json
import math
import struct

MAX_PRESET_BYTES = 256 * 1024


def decode_preset(compressed):
    import lz4.block
    if not isinstance(compressed, bytes) or len(compressed) > MAX_PRESET_BYTES:
        raise ValueError('Invalid compressed preset size')
    try:
        raw = lz4.block.decompress(compressed, uncompressed_size=MAX_PRESET_BYTES)
        preset = json.loads(raw)
    except (lz4.block.LZ4BlockError, UnicodeError, ValueError) as error:
        raise ValueError('The amp returned an invalid preset definition') from error
    validate_preset(preset)
    return preset


def validate_preset(preset):
    if not isinstance(preset, dict) or preset.get('nodeType') != 'preset':
        raise ValueError('Expected a Micro Plus preset definition')
    info = preset.get('info')
    graph = preset.get('audioGraph')
    if not isinstance(info, dict) or not isinstance(info.get('displayName'), str):
        raise ValueError('The preset has no name')
    if not isinstance(graph, dict) or not isinstance(graph.get('nodes'), list):
        raise ValueError('The preset has no signal chain')
    if not 1 <= len(graph['nodes']) <= 32:
        raise ValueError('Invalid signal-chain size')
    seen = set()
    for node in graph['nodes']:
        if not isinstance(node, dict):
            raise ValueError('Invalid signal-chain module')
        node_id = node.get('nodeId')
        if not isinstance(node_id, str) or not node_id or node_id in seen:
            raise ValueError('Invalid or duplicate module identifier')
        seen.add(node_id)
        if not isinstance(node.get('FenderId'), str):
            raise ValueError('Missing amplifier/effect model identifier')
        parameters = node.get('dspUnitParameters')
        if not isinstance(parameters, dict):
            raise ValueError('Missing module parameters')
        for key, value in parameters.items():
            if not isinstance(key, str) or type(value) not in (str, bool, int, float):
                raise ValueError('Invalid module parameter')
            if type(value) in (int, float) and not math.isfinite(value):
                raise ValueError('Parameter values must be finite')
    # Reject NaN/Infinity anywhere in the document before retaining/exporting it.
    json.dumps(preset, allow_nan=False)


def wire_varint(value):
    if type(value) is not int or not 0 <= value < 2**64:
        raise ValueError('Expected an unsigned protobuf integer')
    output = bytearray()
    while value >= 128:
        output.append((value & 127) | 128)
        value >>= 7
    output.append(value)
    return bytes(output)


def wire_bytes(number, value):
    return wire_varint(number * 8 + 2) + wire_varint(len(value)) + value


def wire_string(number, value):
    if not isinstance(value, str):
        raise ValueError('Expected a string')
    return wire_bytes(number, value.encode('utf-8'))


def wire_uint(number, value):
    return wire_varint(number * 8) + wire_varint(value)


def parameter_payload(node_id, parameter_id, value):
    """SetParameterRequest body; the envelope's command ID is separate."""
    result = wire_string(1, node_id) + wire_string(2, parameter_id)
    if type(value) is bool:
        return result + wire_uint(6, int(value))
    if type(value) is float:
        if not math.isfinite(value):
            raise ValueError('Parameter values must be finite')
        try:
            return result + b'\x1d' + struct.pack('<f', value)
        except (OverflowError, struct.error) as error:
            raise ValueError('Parameter value is too large') from error
    if type(value) is int:
        if not -(2**31) <= value < 2**31:
            raise ValueError('Integer parameter is out of range')
        return result + wire_uint(5, (value << 1) ^ (value >> 31))
    if type(value) is str:
        return result + wire_string(4, value)
    raise ValueError('Unsupported parameter value type')


def save_current_payload(name, slot):
    if type(slot) is not int or not 1 <= slot <= 100:
        raise ValueError('Choose a preset number from 1 to 100')
    if not isinstance(name, str) or not name.strip() or len(name) > 16 or any(ord(c) < 32 for c in name):
        raise ValueError('Enter a preset name')
    return wire_string(1, name) + wire_uint(2, slot - 1)


def fragments(payload, max_payload=117):
    if not 1 <= max_payload <= 255:
        raise ValueError('Invalid Bluetooth frame size')
    if not payload or len(payload) > MAX_PRESET_BYTES:
        raise ValueError('Invalid command size')
    chunks = [payload[i:i + max_payload] for i in range(0, len(payload), max_payload)]
    result = []
    for i, chunk in enumerate(chunks):
        marker = 0x35 if i == len(chunks) - 1 else (0x33 if i == 0 else 0x34)
        result.append(bytes((marker, 0, len(chunk))) + chunk)
    return result

# Recovered from mp/MustangLtxAppMessage.proto descriptors in Fender Tone.
# These are command/response identifiers, not inferred by probing the device.
CURRENT = 4
SAVE_CURRENT = 5
READ_PRESET = 12
REPLACE_NODE = 17
SAVE_AS = 18
SET_PARAMETER = 20


def request(kind, payload):
    return wire_bytes(1, wire_bytes(kind, payload))


def parameter_value(content):
    if 3 in content:
        if not isinstance(content[3], bytes) or len(content[3]) != 4:
            raise ValueError('Invalid float parameter response')
        return struct.unpack('<f', content[3])[0]
    if 4 in content:
        return content[4].decode('utf-8')
    if 5 in content:
        encoded = content[5]
        return (encoded >> 1) ^ -(encoded & 1)
    if 6 in content:
        return bool(content[6])
    # Proto3 omits zero/default values. These replies require a type hint from
    # the current preset to distinguish numeric zero, false, and empty string.
    return None


def presets_match(expected, actual):
    """Compare signal-chain content, allowing float32 serialization rounding."""
    def equal(a, b):
        if type(a) in (int, float) and type(b) in (int, float):
            return math.isclose(a, b, rel_tol=1e-5, abs_tol=1e-5)
        if isinstance(a, dict) and isinstance(b, dict):
            # Saved factory definitions can contain the default input mapping
            # that current-preset reports omit. Other values must still match.
            a = {k: v for k, v in a.items() if not (k == 'gateDetectorPosition' and v == 'jack')}
            b = {k: v for k, v in b.items() if not (k == 'gateDetectorPosition' and v == 'jack')}
            return a.keys() == b.keys() and all(equal(a[k], b[k]) for k in a)
        if isinstance(a, list) and isinstance(b, list):
            return len(a) == len(b) and all(equal(x, y) for x, y in zip(a, b))
        return type(a) is type(b) and a == b
    return (expected['info']['displayName'].rstrip() == actual['info']['displayName'].rstrip()
            and equal(expected['audioGraph'], actual['audioGraph']))

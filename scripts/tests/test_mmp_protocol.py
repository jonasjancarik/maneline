"""Regression tests for Micro Plus editor wire types and compressed presets."""
import json
import struct
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mmp_ble import Frames, fields
from mmp_protocol import (decode_preset, fragments, parameter_payload,
                          save_current_payload, validate_preset)


def preset_fixture():
    return {'nodeType': 'preset', 'info': {'displayName': 'Test'},
            'audioGraph': {'nodes': [{'nodeId': 'amp', 'FenderId': 'ACD_LinearGainGT',
                                     'dspUnitParameters': {'gain': 0.5, 'gatePreset': 'off'}}]}}


class PresetTests(unittest.TestCase):
    def test_decodes_raw_lz4_block_without_fixed_protobuf_offsets(self):
        import lz4.block
        original = preset_fixture()
        compressed = lz4.block.compress(json.dumps(original).encode(), store_size=False)
        self.assertEqual(decode_preset(compressed), original)

    def test_corrupt_compression_rejected(self):
        with self.assertRaises(ValueError):
            decode_preset(b'broken')

    def test_nonfinite_parameters_rejected(self):
        for value in (float('nan'), float('inf')):
            preset = preset_fixture()
            preset['audioGraph']['nodes'][0]['dspUnitParameters']['gain'] = value
            with self.assertRaises(ValueError):
                validate_preset(preset)

    def test_duplicate_node_ids_rejected(self):
        preset = preset_fixture()
        preset['audioGraph']['nodes'].append(preset['audioGraph']['nodes'][0].copy())
        with self.assertRaises(ValueError):
            validate_preset(preset)

    def test_premature_final_marker_waits_for_envelope_length(self):
        data = b'\x12\x08abcdefgh'
        frames = Frames()
        self.assertIsNone(frames.feed(bytes([0x33, 0, 3]) + data[:3]))
        self.assertIsNone(frames.feed(bytes([0x35, 0, 3]) + data[3:6]))
        self.assertEqual(frames.feed(bytes([0x35, 0, 4]) + data[6:]), data)

    def test_default_input_mapping_can_be_omitted_in_current_state(self):
        from mmp_protocol import presets_match
        original = preset_fixture()
        current = preset_fixture()
        original['audioGraph']['nodes'][0]['dspUnitParameters']['gateDetectorPosition'] = 'jack'
        self.assertTrue(presets_match(original, current))
        original['audioGraph']['nodes'][0]['dspUnitParameters']['gateDetectorPosition'] = 'different'
        self.assertFalse(presets_match(original, current))

    def test_float_parameter_uses_ieee754_wire_type(self):
        payload = dict(fields(parameter_payload('amp', 'gain', 0.625)))
        self.assertEqual(payload[1], b'amp')
        self.assertEqual(payload[2], b'gain')
        self.assertEqual(struct.unpack('<f', payload[3])[0], 0.625)

    def test_boolean_and_signed_integer_types(self):
        self.assertEqual(dict(fields(parameter_payload('stomp', 'bypass', True)))[6], 1)
        self.assertEqual(dict(fields(parameter_payload('amp', 'choice', -2)))[5], 3)
        self.assertEqual(dict(fields(parameter_payload('amp', 'choice', 2)))[5], 4)

    def test_save_uses_display_slot_minus_one(self):
        self.assertEqual(dict(fields(save_current_payload('Editor test', 100))),
                         {1: b'Editor test', 2: 99})

    def test_fragmentation_reassembles_large_commands(self):
        original = b'x' * 1000
        frames = fragments(original)
        decoder = Frames()
        for frame in frames[:-1]:
            self.assertIsNone(decoder.feed(frame))
        self.assertEqual(decoder.feed(frames[-1]), original)
        self.assertTrue(all(len(frame) <= 120 for frame in frames))


if __name__ == '__main__':
    unittest.main()

#!/usr/bin/env python3
"""Experimental Mustang Micro Plus BLE controller (CoreBluetooth on macOS)."""
import argparse
import copy
import math
import asyncio
import json
import sys
import time
import uuid
from pathlib import Path

SERVICE = '90559580-b707-11ee-acb1-7b7e30f1af54'
REQUEST = '820a7e34-4e0a-4f90-8520-04ebce35a3a1'
RESPONSE = '1017adcc-dcbc-4387-a59f-2546b2ea5bb0'
from mmp_protocol import (CURRENT, SAVE_CURRENT, READ_PRESET, REPLACE_NODE, SAVE_AS,
                          SET_PARAMETER, decode_preset, fragments, parameter_payload,
                          parameter_value, presets_match, request, save_current_payload,
                          wire_bytes, wire_string, wire_uint)

NAME = 'Mustang Micro Plus'
# Firmware 1.1.11 stops sending notifications with one-second keep-alives.
# Keep a margin below the 500 ms interval used by the original BLE experiment.
KEEPALIVE_INTERVAL = 0.25
KEEPALIVE = bytes.fromhex('3500050a03c20100')


def varint(value):
    result = bytearray()
    while value >= 128:
        result.append((value & 127) | 128)
        value >>= 7
    result.append(value)
    return bytes(result)


def read_varint(data, offset):
    value = 0
    for shift in range(0, 70, 7):
        if offset >= len(data):
            raise ValueError('Truncated protobuf integer')
        byte = data[offset]
        offset += 1
        value |= (byte & 127) << shift
        if byte < 128:
            return value, offset
    raise ValueError('Protobuf integer is too long')


def fields(data):
    """Decode only the protobuf wire types used by the captured messages."""
    result = []
    offset = 0
    while offset < len(data):
        tag, offset = read_varint(data, offset)
        number, wire = tag >> 3, tag & 7
        if number == 0:
            raise ValueError('Invalid protobuf field zero')
        if wire == 0:
            value, offset = read_varint(data, offset)
        elif wire in (1, 2, 5):
            if wire == 2:
                length, offset = read_varint(data, offset)
            else:
                length = 8 if wire == 1 else 4
            if offset + length > len(data):
                raise ValueError('Truncated protobuf field')
            value = data[offset:offset + length]
            offset += length
        else:
            raise ValueError(f'Unsupported protobuf wire type {wire}')
        result.append((number, value))
    return result


def packet(payload):
    if len(payload) > 255:
        raise ValueError('Command is too large for one BLE frame')
    return bytes((0x35, 0, len(payload))) + payload


def select_preset(slot):
    if not 1 <= slot <= 100:
        raise ValueError('Preset number must be between 1 and 100')
    # Captured switch 3500060a0442020847 selects displayed preset 72.
    index = b'\x08' + varint(slot - 1)
    command = b'\x42' + varint(len(index)) + index
    return packet(b'\x0a' + varint(len(command)) + command)


class Frames:
    def __init__(self):
        self.buffer = bytearray()

    def feed(self, data):
        if len(data) < 3 or data[0] not in (0x33, 0x34, 0x35) or data[1] != 0:
            self.buffer.clear()
            raise ValueError('Invalid Micro Plus BLE frame header')
        length = data[2]
        if length != len(data) - 3:
            self.buffer.clear()
            raise ValueError('BLE frame length does not match payload')
        if data[0] == 0x33:
            self.buffer.clear()
        elif data[0] == 0x34 and not self.buffer:
            raise ValueError('Continuation without a starting frame')
        self.buffer.extend(data[3:])
        if len(self.buffer) > 65536:
            self.buffer.clear()
            raise ValueError('Micro Plus response exceeds 64 KiB')
        if data[0] != 0x35:
            return None
        message = bytes(self.buffer)
        if message.startswith(b'\x12'):
            # The captured Micro Plus transport can mark an intermediate chunk
            # as final. The protobuf envelope length is the completion signal.
            try:
                length, offset = read_varint(message, 1)
            except ValueError:
                return None
            expected = offset + length
            if expected > 65536:
                self.buffer.clear()
                raise ValueError('Micro Plus response exceeds 64 KiB')
            if len(message) < expected:
                return None
            if len(message) > expected:
                self.buffer.clear()
                raise ValueError('Response exceeds its protobuf envelope length')
        self.buffer.clear()
        return message


class Controller:
    def __init__(self, client, log):
        self.client = client
        self.log = log
        self.frames = Frames()
        self.slot = None
        self.names = []
        self.changed = asyncio.Event()
        self.failure = None
        self.write_lock = asyncio.Lock()
        self.document = None
        self.document_slot = None
        self.document_revision = 0
        self.stored = {}
        self.stored_revisions = {}
        self.parameters = {}
        self.parameter_revision = 0
        self.parameter_types = {}
        self.dirty = False
        self.saved = None
        self.save_revision = 0
        self.command_error = None
        self.replaced = None
        self.replace_revision = 0

    def record(self, direction, data):
        if self.log:
            self.log.write(json.dumps({'time': time.time(), 'direction': direction,
                                       'hex': bytes(data).hex()}) + '\n')
            self.log.flush()

    def notify(self, _characteristic, data):
        self.record('rx', data)
        try:
            message = self.frames.feed(data)
            if message is None or not message.startswith(b'\x12'):
                return
            outer = fields(message)
            for number, body in outer:
                if number != 2 or not isinstance(body, bytes):
                    continue
                for kind, value in fields(body):
                    # Captures: 12..08012a..08<zero-based-slot>2001.
                    if kind == 5 and isinstance(value, bytes):
                        content = dict(fields(value))
                        self.slot = content.get(1, 0) + 1
                        self.dirty = bool(content.get(2, 0))
                        self.changed.set()
                    elif kind == 4 and isinstance(value, bytes):
                        self.document = decode_preset(dict(fields(value)).get(1, b''))
                        self.document_slot = self.slot
                        self.document_revision += 1
                        self.changed.set()
                    elif kind == 10 and isinstance(value, bytes):
                        content = dict(fields(value))
                        slot = content.get(1, 0) + 1
                        self.stored[slot] = decode_preset(content.get(2, b''))
                        self.stored_revisions[slot] = self.stored_revisions.get(slot, 0) + 1
                        self.changed.set()
                    elif kind == 9 and isinstance(value, bytes):
                        content = dict(fields(value))
                        node = content.get(1, b'').decode('utf-8')
                        parameter = content.get(2, b'').decode('utf-8')
                        result = parameter_value(content)
                        if result is None and self.document:
                            old = self.get_parameter(node, parameter)
                            result = False if type(old) is bool else ('' if type(old) is str else 0)
                        self.parameters[(node, parameter)] = result
                        self.parameter_types[(node, parameter)] = next((k for k in (3, 4, 5, 6) if k in content), None)
                        self.parameter_revision += 1
                        self.changed.set()
                    elif kind == 13 and isinstance(value, bytes):
                        content = dict(fields(value))
                        self.saved = {'preset': content.get(1, 0) + 1,
                                      'name': content.get(2, b'').decode('utf-8').rstrip()}
                        self.save_revision += 1
                        if self.saved['preset'] <= len(self.names):
                            self.names[self.saved['preset'] - 1] = self.saved['name']
                        self.changed.set()
                    elif kind == 15 and isinstance(value, bytes):
                        content = dict(fields(value))
                        self.replaced = (content.get(1, b'').decode('utf-8'),
                                         content.get(2, b'').decode('utf-8'))
                        self.replace_revision += 1
                        self.changed.set()
                    elif kind == 17 and isinstance(value, bytes):
                        code = dict(fields(value)).get(1, 0)
                        errors = ('unsupported command', 'operation failed', 'invalid parameter',
                                  'invalid module', 'parameter value out of range', 'factory restore in progress')
                        self.command_error = ValueError('The Micro Plus rejected the change: ' +
                                                        (errors[code] if code < len(errors) else str(code)))
                        self.changed.set()
                    elif kind == 12 and isinstance(value, bytes):
                        self.names = [name.decode('utf-8').rstrip() for key, name in fields(value)
                                      if key == 1 and isinstance(name, bytes)]
                        self.changed.set()
        except (ValueError, UnicodeError) as error:
            self.failure = error
            self.changed.set()

    async def send_packets(self, packets):
        characteristic = self.client.services.get_characteristic(REQUEST)
        if characteristic is None:
            raise RuntimeError('Micro Plus control characteristic was not found')
        response = 'write-without-response' not in characteristic.properties
        async with self.write_lock:
            for data in packets:
                self.record('tx', data)
                await self.client.write_gatt_char(characteristic, data, response=response)

    async def send(self, data):
        await self.send_packets([data])

    async def command(self, kind, payload):
        self.command_error = None
        await self.send_packets(fragments(request(kind, payload)))

    async def initialize(self):
        # Read-only handshake from the checked-in Android Tone captures.
        for hex_data in ('3500021a00', '3500040a023a00', '3500040a027200',
                         '3500060a0422020801', '3500050a03b20100',
                         '3500050a03ca0100', '3500041a020801'):
            await self.send(bytes.fromhex(hex_data))
            await asyncio.sleep(0.15)
        await self.wait_for(lambda: self.slot is not None and bool(self.names))

    async def wait_for(self, predicate, timeout=8):
        async with asyncio.timeout(timeout):
            while not predicate():
                self.changed.clear()
                if self.failure:
                    raise self.failure
                if self.command_error:
                    raise self.command_error
                if not self.client.is_connected:
                    raise RuntimeError('Micro Plus disconnected')
                await self.changed.wait()

    def status(self):
        return {'preset': self.slot, 'name': self.names[self.slot - 1]
                if self.slot and self.slot <= len(self.names) else None}

    async def switch(self, slot):
        command = select_preset(slot)
        self.slot = None
        self.document = None
        self.document_slot = None
        await self.send(command)
        await self.wait_for(lambda: self.slot == slot)
        return self.status()


    async def refresh_current(self):
        revision = self.document_revision
        await self.command(CURRENT, wire_uint(1, 1))
        await self.wait_for(lambda: self.document_revision > revision)
        return copy.deepcopy(self.document)

    async def read_preset(self, slot):
        if type(slot) is not int or not 1 <= slot <= 100:
            raise ValueError('Choose a preset number from 1 to 100')
        revision = self.stored_revisions.get(slot, 0)
        await self.command(READ_PRESET, wire_uint(1, slot - 1) + wire_uint(2, 1))
        await self.wait_for(lambda: self.stored_revisions.get(slot, 0) > revision)
        return copy.deepcopy(self.stored[slot])

    def get_parameter(self, node_id, parameter):
        if not self.document:
            raise ValueError('Read the current preset before editing')
        for node in self.document['audioGraph']['nodes']:
            if node['nodeId'] == node_id and parameter in node['dspUnitParameters']:
                return node['dspUnitParameters'][parameter]
        raise ValueError('This parameter is not present in the selected preset')

    async def set_parameter(self, node_id, parameter, value):
        old = self.get_parameter(node_id, parameter)
        if type(old) in (int, float):
            if type(value) not in (int, float) or not math.isfinite(value):
                raise ValueError('Enter a finite number for this parameter')
        elif type(value) is not type(old):
            raise ValueError('Parameter value has the wrong type')
        # Ask the amp for the wire type; an integer-looking JSON value can
        # represent either a continuous float control or a discrete choice.
        slot = self.slot
        document_revision = self.document_revision
        key = (node_id, parameter)
        revision = self.parameter_revision
        self.parameters.pop(key, None)
        await self.command(11, wire_string(1, node_id) + wire_string(2, parameter))
        await self.wait_for(lambda: self.parameter_revision > revision and key in self.parameters)
        if self.slot != slot or self.document_revision != document_revision:
            raise ValueError('The selected preset changed. Review it before editing.')
        wire_type = self.parameter_types.get(key)
        if type(old) in (int, float):
            integer_choices = {'comppreset', 'mode', 'type', 'dlymodtype', 'panmodtype',
                               'modshape', 'inputfiltermode', 'lfoclip', 'prefilttype', 'shape'}
            if wire_type == 5 or (wire_type is None and parameter in integer_choices):
                if value != int(value):
                    raise ValueError('Choose a whole number for this parameter')
                value = int(value)
            else:
                value = float(value)
        revision = self.parameter_revision
        key = (node_id, parameter)
        self.parameters.pop(key, None)
        await self.command(SET_PARAMETER, parameter_payload(node_id, parameter, value))
        await self.wait_for(lambda: self.parameter_revision > revision and key in self.parameters)
        reported = self.parameters[key]
        limited = False
        if type(value) in (int, float):
            # The amp keeps numbers within its own limits and reports what it stored, which isn't a failure.
            if type(reported) not in (int, float) or not math.isfinite(reported):
                raise RuntimeError('The Micro Plus reported a different parameter value')
            limited = not math.isclose(value, reported, rel_tol=1e-5, abs_tol=1e-5)
        elif value != reported:
            raise RuntimeError('The Micro Plus reported a different parameter value')
        await self.refresh_current()
        if not limited:
            return None
        # The value differs from the one sent, so make sure the preset itself agrees before accepting it.
        stored = self.get_parameter(node_id, parameter)
        if type(stored) not in (int, float) or not math.isclose(stored, reported, rel_tol=1e-4, abs_tol=1e-4):
            raise RuntimeError('The Micro Plus reported a different parameter value')
        return reported

    async def replace_node(self, node_id, model):
        revision = self.replace_revision
        await self.command(REPLACE_NODE, wire_string(1, node_id) + wire_string(2, model))
        await self.wait_for(lambda: self.replace_revision > revision and self.replaced == (node_id, model))
        await self.refresh_current()

    async def save_current(self, name, target):
        expected = copy.deepcopy(self.document)
        if not expected:
            raise ValueError('Read the current preset before saving')
        payload = save_current_payload(name, target)
        expected['info']['displayName'] = name
        if target != self.slot:
            # A copied sound gets its own identity; do not alias the source
            # preset's UUID or factory-default status in the destination slot.
            expected['info']['preset_id'] = str(uuid.uuid4()).upper()
            expected['info']['is_factory_default'] = False
            stored = await self.restore_preset(expected, target)
            await self.refresh_current()
            return stored
        revision = self.save_revision
        await self.command(SAVE_CURRENT, payload)
        await self.wait_for(lambda: self.save_revision > revision and self.saved['preset'] == target)
        stored = await self.read_preset(target)
        if not presets_match(expected, stored):
            raise RuntimeError('The saved preset does not match the requested changes')
        await self.refresh_current()
        return stored

    async def restore_preset(self, preset, slot):
        import lz4.block
        from mmp_protocol import validate_preset
        validate_preset(preset)
        if type(slot) is not int or not 1 <= slot <= 100:
            raise ValueError('Choose a preset number from 1 to 100')
        name = preset['info']['displayName'].rstrip()
        raw = json.dumps(preset, separators=(',', ':'), allow_nan=False).encode()
        compressed = lz4.block.compress(raw, store_size=False)
        payload = (wire_uint(1, slot - 1) + wire_bytes(2, compressed) +
                   wire_uint(3, 1) + wire_string(4, name))
        revision = self.save_revision
        await self.command(SAVE_AS, payload)
        await self.wait_for(lambda: self.save_revision > revision and self.saved['preset'] == slot)
        actual = await self.read_preset(slot)
        if not presets_match(preset, actual):
            raise RuntimeError('Read-back verification of the restored preset failed')
        return actual


async def run(args):
    from bleak import BleakClient, BleakScanner
    print('Looking for Mustang Micro Plus…', file=sys.stderr, flush=True)
    if args.device:
        device = await BleakScanner.find_device_by_filter(
            lambda device, advert: device.address == args.device
            and (advert.local_name == NAME or device.name == NAME),
            timeout=args.timeout, service_uuids=[SERVICE])
        candidates = [device] if device else []
    else:
        devices = await BleakScanner.discover(timeout=args.timeout, return_adv=True,
                                              service_uuids=[SERVICE])
        candidates = [device for device, advert in devices.values()
                      if advert.local_name == NAME or device.name == NAME]
    if not candidates:
        raise RuntimeError('Micro Plus was not found. Turn it on, close Fender Tone on '
                           'other devices, and try again with the Micro Plus nearby.')
    if args.command == 'scan':
        print(json.dumps([{'name': d.name, 'id': d.address} for d in candidates]))
        return
    if len(candidates) != 1:
        raise RuntimeError('More than one Micro Plus found; select one with --device ID')
    log = None
    if args.log:
        Path(args.log).parent.mkdir(parents=True, exist_ok=True)
        log = open(args.log, 'a', encoding='utf-8')
    try:
        async with BleakClient(candidates[0], timeout=args.timeout) as client:
            print('Connected to Mustang Micro Plus', file=sys.stderr, flush=True)
            controller = Controller(client, log)
            await client.start_notify(RESPONSE, controller.notify)
            await controller.initialize()
            if args.command == 'presets':
                await controller.wait_for(lambda: bool(controller.names))
                print(json.dumps([{'preset': i + 1, 'name': name}
                                  for i, name in enumerate(controller.names)]))
            elif args.command == 'preset':
                print(json.dumps(await controller.switch(args.slot)))
            else:
                print(json.dumps(controller.status()), flush=True)
    finally:
        if log:
            log.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--device', help='CoreBluetooth device UUID from scan')
    parser.add_argument('--timeout', type=float, default=15)
    parser.add_argument('--log', help='Append timestamped BLE traffic to a JSONL file')
    commands = parser.add_subparsers(dest='command', required=True)
    for command in ('scan', 'status', 'presets'):
        commands.add_parser(command)
    switch = commands.add_parser('preset')
    switch.add_argument('slot', type=int, choices=range(1, 101), metavar='1–100')
    args = parser.parse_args()
    from bleak.exc import BleakError
    try:
        asyncio.run(run(args))
    except (RuntimeError, ValueError, TimeoutError, BleakError) as error:
        message = str(error).strip()
        if not message:
            message = ('Timed out waiting for a Bluetooth response. Reconnect with '
                       'status to check which preset is selected.')
        print(f'Could not complete the request: {message}',
              file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130
    return 0


if __name__ == '__main__':
    sys.exit(main())

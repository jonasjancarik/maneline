#!/usr/bin/env python3
"""Serve the Micro Plus page against a simulated amp, for UI work and failure testing.

Nothing here touches Bluetooth. Control the simulation from a browser or curl:
  /__mock/mode/ok            normal behaviour
  /__mock/mode/disconnected  the amp disappears until the mode changes again
  /__mock/mode/fail          the next writes are not confirmed
  /__mock/mode/stall         the next switch reaches the amp but is not confirmed
  /__mock/knob/5             someone turns the knob on the amp to preset 5
  /__mock/limit/delay/feedback/0.3  the amp stores no more than 0.3 for that setting
  /__mock/requests           every write the page has sent
"""
import argparse
import asyncio
import copy
import json
import time
import uuid
from pathlib import Path
from mmp_session import EditorConflict, MODELS, PARAMETER_CHOICES, UNSCALED
from mmp_web import dispatch, handle

FIXTURE = json.loads(Path(__file__).with_name('mmp_mock_fixture.json').read_text())
STALL_SECONDS, RECONNECT_SECONDS = 8, 3


class MockSession:
    def __init__(self, delay=0.8):
        self.delay = delay
        self.names = list(FIXTURE['names'])
        self.slot = FIXTURE['active']
        self.stored = {}
        self.document = self.read(self.slot)
        self.mode = 'ok'
        self.dirty = False
        self.error = None
        self.generation = uuid.uuid4().hex
        self.document_revision = 1
        self.connections = 1
        self.last_save = None
        self.last_undo = None
        self.backups = {}
        self.requests = []
        self.limits = {}

    def read(self, slot):
        if slot not in self.stored:
            document = copy.deepcopy(FIXTURE['document'])
            document['info']['displayName'] = self.names[slot - 1]
            self.stored[slot] = document
        return copy.deepcopy(self.stored[slot])

    @property
    def connected(self):
        return self.mode != 'disconnected'

    def snapshot(self):
        connected = self.connected
        return {'connected': connected, 'phase': 'connected' if connected else 'disconnected',
                'error': None if connected else self.error or 'Micro Plus not found. Turn it on and close Fender Tone on other devices.',
                'device': 'Simulated Micro Plus', 'connections': self.connections,
                'connected_since': None, 'preset': self.slot if connected else None,
                'name': self.names[self.slot - 1] if connected else None,
                'presets': [{'preset': i + 1, 'name': name} for i, name in enumerate(self.names)] if connected else [],
                'document': self.document if connected else None,
                'revision': f'{self.generation}:{self.document_revision}' if connected else None,
                'dirty': self.dirty if connected else False,
                'models': MODELS, 'parameter_choices': PARAMETER_CHOICES, 'unscaled': UNSCALED,
                'last_save': self.last_save, 'last_undo': self.last_undo}

    def set_mode(self, mode):
        if mode not in ('ok', 'disconnected', 'fail', 'stall'):
            raise ValueError('Unknown mode')
        if self.mode == 'disconnected' and mode != 'disconnected':
            self.reconnect()
        self.mode = mode
        return {'mode': mode}

    def reconnect(self):
        self.generation = uuid.uuid4().hex
        self.connections += 1
        self.error = None
        self.dirty = False
        self.document = self.read(self.slot)

    def knob(self, slot):
        self.slot = slot
        self.document = self.read(slot)
        self.dirty = False
        self.document_revision += 1
        return {'preset': slot}

    async def begin(self, action, body):
        self.requests.append({'time': time.time(), 'action': action, **body})
        await asyncio.sleep(self.delay)
        if not self.connected:
            raise RuntimeError('The Micro Plus is disconnected. Wait for it to reconnect.')
        if self.mode == 'fail':
            raise RuntimeError(f'The Micro Plus did not confirm the {action}. Reconnecting to read its current settings.')

    def require_editor(self, slot, revision):
        if slot != self.slot or revision != f'{self.generation}:{self.document_revision}':
            raise EditorConflict('The preset changed while you were editing. Review its current settings and try again.')

    def node(self, node_id):
        for node in self.document['audioGraph']['nodes']:
            if node['nodeId'] == node_id:
                return node
        raise ValueError('That module is not present in the current preset.')

    async def switch(self, slot):
        if type(slot) is not int or not 1 <= slot <= 100:
            raise ValueError('Choose a preset number from 1 to 100.')
        if self.mode == 'stall':
            self.requests.append({'time': time.time(), 'action': 'switch', 'preset': slot})
            await asyncio.sleep(STALL_SECONDS)
            self.slot = slot
            self.error = ('The Micro Plus did not confirm the switch, so it may already be on the new preset. '
                          'Reconnecting to check.')
            self.mode = 'disconnected'
            asyncio.get_running_loop().call_later(RECONNECT_SECONDS, self.set_mode, 'ok')
            raise RuntimeError(self.error)
        await self.begin('switch', {'preset': slot})
        self.knob(slot)
        return self.snapshot()

    async def edit(self, slot, revision, node, parameter, value):
        self.require_editor(slot, revision)
        await self.begin('parameter', {'node': node, 'parameter': parameter, 'value': value})
        self.require_editor(slot, revision)
        parameters = self.node(node)['dspUnitParameters']
        if parameter not in parameters:
            raise ValueError('This parameter is not present in the selected preset')
        limit = self.limits.get((node, parameter))
        stored = min(value, limit) if limit is not None else value
        parameters[parameter] = stored
        self.dirty = True
        self.document_revision += 1
        snapshot = self.snapshot()
        if stored != value:
            snapshot['limited'] = {'node': node, 'parameter': parameter, 'requested': value, 'stored': stored}
        return snapshot

    async def replace(self, slot, revision, node, model):
        self.require_editor(slot, revision)
        await self.begin('model', {'node': node, 'model': model})
        self.node(node)['FenderId'] = model
        self.dirty = True
        self.document_revision += 1
        return self.snapshot()

    async def save(self, slot, revision, target, name):
        self.require_editor(slot, revision)
        await self.begin('save', {'target': target, 'name': name})
        backup = f'{time.strftime("%Y%m%dT%H%M%S")}Z-preset-{target:03d}.json'
        self.backups[backup] = (self.read(target), self.names[target - 1])
        saved = copy.deepcopy(self.document)
        saved['info']['displayName'] = name
        self.stored[target] = saved
        self.names[target - 1] = name
        self.last_save = {'preset': target, 'name': name, 'backup': backup, 'verified': True, 'time': time.time()}
        if target == self.slot:
            self.document = copy.deepcopy(saved)
            self.dirty = False
        self.document_revision += 1
        return self.snapshot()

    async def undo_save(self, slot, revision):
        self.require_editor(slot, revision)
        if not self.last_save:
            raise ValueError('There is no recent save to undo.')
        await self.begin('undo', {})
        target = self.last_save['preset']
        self.stored[target], self.names[target - 1] = self.backups[self.last_save['backup']]
        self.last_undo = {'preset': target, 'backup': self.last_save['backup'], 'time': time.time()}
        self.last_save = None
        if target == self.slot:
            self.document = self.read(target)
            self.dirty = False
        self.document_revision += 1
        return self.snapshot()


async def mock_dispatch(method, path, headers, body, session, allowed_hosts=None):
    if path.startswith('/__mock/'):
        parts = path.split('/')[2:]
        if parts[0] == 'mode':
            result = session.set_mode(parts[1])
        elif parts[0] == 'knob':
            result = session.knob(int(parts[1]))
        elif parts[0] == 'limit':
            session.limits[(parts[1], parts[2])] = float(parts[3])
            result = session.snapshot()
        else:
            result = session.requests
        return 200, 'application/json', json.dumps(result).encode()
    return await dispatch(method, path, headers, body, session, allowed_hosts)


async def run(args):
    session = MockSession(args.delay)
    server = await asyncio.start_server(
        lambda r, w: handle(r, w, session, None, mock_dispatch), '0.0.0.0', args.port, limit=8192)
    print(f'Simulated Micro Plus (no Bluetooth): http://localhost:{args.port}', flush=True)
    async with server:
        await server.serve_forever()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--port', type=int, default=8092)
    parser.add_argument('--delay', type=float, default=0.8, help='Seconds each simulated amp write takes')
    args = parser.parse_args()
    try:
        asyncio.run(run(args))
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()

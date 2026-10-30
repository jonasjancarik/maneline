"""Own one persistent Micro Plus connection and serialize browser commands."""
import asyncio
import contextlib
import json
import os
import sys
import time
import traceback
import uuid
from datetime import datetime, timezone
from pathlib import Path
from mmp_ble import Controller, KEEPALIVE, KEEPALIVE_INTERVAL, NAME, RESPONSE, SERVICE

MODELS = json.loads(Path(__file__).with_name('mmp_models.json').read_text())
PARAMETER_CHOICES = json.loads(Path(__file__).with_name('mmp_parameter_choices.json').read_text())
UNSCALED = json.loads(Path(__file__).with_name('mmp_parameter_hints.json').read_text())


class EditorConflict(ValueError):
    """The device selection changed since the browser read the editor."""


class MicroPlusSession:
    def __init__(self, device=None, log=None, backup_dir='_work/preset-backups'):
        self.device_id = device
        self.log = log
        self.backup_dir = Path(backup_dir)
        self.controller = None
        self.client = None
        self.error = None
        self.phase = 'connecting'
        self.connections = 0
        self.connected_since = None
        self.lock = asyncio.Lock()
        self.reset = asyncio.Event()
        self.last_save = None
        self.last_undo = None
        self.generation = 0

    def snapshot(self):
        controller = self.controller
        connected = bool(controller and self.client and self.client.is_connected)
        return {'connected': connected, 'phase': self.phase, 'error': self.error,
                'device': NAME, 'connections': self.connections,
                'connected_since': self.connected_since,
                'preset': controller.slot if connected else None,
                'name': controller.status()['name'] if connected else None,
                'presets': [{'preset': i + 1, 'name': name}
                            for i, name in enumerate(controller.names)] if connected else [],
                'document': getattr(controller, 'document', None) if connected else None,
                'revision': f'{self.generation}:{getattr(controller, "document_revision", 0)}' if connected else None,
                'dirty': bool(getattr(controller, 'dirty', False)) if connected else False,
                'models': MODELS, 'parameter_choices': PARAMETER_CHOICES, 'unscaled': UNSCALED, 'last_save': self.last_save,
                'last_undo': self.last_undo}

    def require_controller(self):
        if not self.controller or not self.client or not self.client.is_connected:
            raise RuntimeError('The Micro Plus is disconnected. Wait for it to reconnect.')
        return self.controller

    def require_editor(self, slot, revision):
        controller = self.require_controller()
        if (type(slot) is not int or controller.slot != slot or
                revision != self.snapshot()['revision'] or not controller.document or
                controller.document_slot != slot):
            raise EditorConflict('The preset changed while you were editing. Review its current settings and try again.')
        return controller

    def unconfirmed(self, action):
        # Callers replace the exception with a friendly message, so this is the only record of the cause.
        print(f'Micro Plus {action} not confirmed:', file=sys.stderr)
        traceback.print_exc()
        sys.stderr.flush()
        messages = {
            'save': 'The save could not be verified. Reconnecting to read the device; check the result before saving again.',
            'undo': 'The undo could not be verified. Reconnecting to read the device; check the result before saving again.',
            'preset selection': 'The Micro Plus did not confirm the switch, so it may already be on the new preset. '
                                'Reconnecting to check.'}
        self.error = messages.get(action, f'The Micro Plus did not confirm the {action}. '
                                          'Reconnecting to read its current settings.')
        self.controller = None
        self.reset.set()
        return RuntimeError(self.error)

    async def switch(self, slot):
        if type(slot) is not int or not 1 <= slot <= 100:
            raise ValueError('Choose a preset number from 1 to 100.')
        async with self.lock:
            controller = self.require_controller()
            try:
                await controller.switch(slot)
                await controller.refresh_current()
                return self.snapshot()
            except ValueError:
                raise
            except Exception:
                raise self.unconfirmed('preset selection') from None

    async def edit(self, slot, revision, node, parameter, value):
        async with self.lock:
            controller = self.require_editor(slot, revision)
            if not isinstance(node, str) or not isinstance(parameter, str):
                raise ValueError('Choose an amplifier or effect parameter.')
            try:
                limited = await controller.set_parameter(node, parameter, value)
                snapshot = self.snapshot()
                if limited is not None:
                    snapshot['limited'] = {'node': node, 'parameter': parameter, 'requested': value, 'stored': limited}
                return snapshot
            except ValueError:
                raise
            except Exception:
                raise self.unconfirmed('parameter change') from None

    async def replace(self, slot, revision, node, model):
        async with self.lock:
            controller = self.require_editor(slot, revision)
            if not isinstance(node, str) or not isinstance(model, str):
                raise ValueError('Choose an amplifier or effect model.')
            if model not in {entry['id'] for entry in MODELS.get(node, [])}:
                raise ValueError('That model is not in the Micro Plus model list.')
            if node not in {entry['nodeId'] for entry in controller.document['audioGraph']['nodes']}:
                raise ValueError('That module is not present in the current preset.')
            try:
                await controller.replace_node(node, model)
                return self.snapshot()
            except ValueError:
                raise
            except Exception:
                raise self.unconfirmed('amplifier or effect change') from None

    def backup(self, slot, document):
        self.backup_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
        path = self.backup_dir / f'{stamp}-preset-{slot:03d}.json'
        with path.open('x', encoding='utf-8') as stream:
            json.dump({'format': 'maneline-micro-plus-backup-v1', 'device': self.device_id,
                       'slot': slot, 'preset': document}, stream, indent=2, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        return path.name

    async def save(self, slot, revision, target, name):
        from mmp_protocol import save_current_payload
        if isinstance(name, str):
            name = name.strip()
        save_current_payload(name, target)  # Validate before reading or writing the device.
        async with self.lock:
            controller = self.require_editor(slot, revision)
            try:
                original = await controller.read_preset(target)
                backup = self.backup(target, original)  # Must succeed before a write is sent.
                # A physical preset change during the backup must not save the wrong sound.
                self.require_editor(slot, revision)
                await controller.save_current(name, target)
                self.last_save = {'preset': target, 'name': name, 'backup': backup,
                                  'verified': True, 'time': time.time()}
                return self.snapshot()
            except (ValueError, OSError):
                raise
            except Exception:
                raise self.unconfirmed('save') from None

    async def undo_save(self, slot, revision):
        async with self.lock:
            controller = self.require_editor(slot, revision)
            save = self.last_save
            if not save:
                raise ValueError('There is no recent save to undo.')
            target = save['preset']
            backup = json.loads((self.backup_dir / save['backup']).read_text(encoding='utf-8'))
            if backup.get('slot') != target:
                raise ValueError('That backup belongs to a different preset, so nothing was changed.')
            try:
                replaced = await controller.read_preset(target)
                safety = self.backup(target, replaced)  # Undo must itself be recoverable.
                self.require_editor(slot, revision)
                await controller.restore_preset(backup['preset'], target)
                if target == controller.slot:
                    # The amp keeps playing its live copy until the slot is selected again.
                    await controller.switch(target)
                await controller.refresh_current()
                self.last_save = None
                self.last_undo = {'preset': target, 'backup': safety, 'time': time.time()}
                return self.snapshot()
            except (ValueError, OSError):
                raise
            except Exception:
                raise self.unconfirmed('undo') from None

    async def keep_alive(self, controller):
        try:
            while not self.reset.is_set():
                await asyncio.sleep(KEEPALIVE_INTERVAL)
                if controller.failure:
                    raise controller.failure
                await controller.send(KEEPALIVE)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            controller.failure = error
            controller.changed.set()
            self.reset.set()

    async def run(self):
        from bleak import BleakClient, BleakScanner
        while True:
            self.reset.clear()
            self.phase = 'connecting'
            try:
                device = await BleakScanner.find_device_by_filter(
                    lambda d, advert: (d.name == NAME or advert.local_name == NAME)
                    and (self.device_id is None or d.address == self.device_id),
                    service_uuids=[SERVICE], timeout=10)
                if device is None:
                    raise RuntimeError('Micro Plus not found. Turn it on and close Fender Tone on other devices.')
                self.device_id = device.address
                async with BleakClient(device, disconnected_callback=lambda _: self.reset.set()) as client:
                    self.client = client
                    controller = Controller(client, self.log)
                    await client.start_notify(RESPONSE, controller.notify)
                    await controller.initialize()
                    keepalive = asyncio.create_task(self.keep_alive(controller))
                    try:
                        await controller.refresh_current()
                        self.controller = controller
                        self.generation = uuid.uuid4().hex
                        self.connections += 1
                        self.connected_since = time.time()
                        self.phase = 'connected'
                        self.error = None
                        await self.reset.wait()
                    finally:
                        keepalive.cancel()
                        with contextlib.suppress(asyncio.CancelledError):
                            await keepalive
            except asyncio.CancelledError:
                raise
            except Exception as error:
                self.error = str(error) or 'The Bluetooth connection was lost.'
            finally:
                self.controller = None
                self.client = None
                self.connected_since = None
                self.phase = 'disconnected'
            await asyncio.sleep(2)

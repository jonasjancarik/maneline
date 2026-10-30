"""Safety checks for saving edited Micro Plus presets."""
import copy
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mmp_ble import Controller
from mmp_protocol import presets_match
from mmp_session import EditorConflict, MicroPlusSession
from mmp_web import dispatch, HTTPError
from test_mmp_protocol import preset_fixture


class EditorTests(unittest.IsolatedAsyncioTestCase):
    def session(self, directory):
        session = MicroPlusSession('device-id', backup_dir=directory)
        current = preset_fixture()
        current['audioGraph']['nodes'][0]['dspUnitParameters']['gain'] = 0.6
        stored = preset_fixture()
        controller = types.SimpleNamespace(slot=100, document_slot=100, document=current,
            document_revision=4, dirty=True, names=['Test'] * 100,
            status=lambda: {'name': 'Test'}, read_preset=AsyncMock(return_value=stored),
            save_current=AsyncMock(), set_parameter=AsyncMock(), replace_node=AsyncMock())
        session.controller = controller
        session.client = types.SimpleNamespace(is_connected=True)
        session.generation = 2
        return session

    async def test_stored_contents_are_backed_up_before_save(self):
        with tempfile.TemporaryDirectory() as directory:
            session = self.session(directory)

            async def save(name, target):
                backups = list(Path(directory).glob('*.json'))
                self.assertEqual(len(backups), 1)
                data = json.loads(backups[0].read_text())
                self.assertEqual(data['slot'], 100)
                self.assertEqual(data['preset']['audioGraph']['nodes'][0]['dspUnitParameters']['gain'], 0.5)
                self.assertEqual(session.controller.document['audioGraph']['nodes'][0]['dspUnitParameters']['gain'], 0.6)

            session.controller.save_current = AsyncMock(side_effect=save)
            result = await session.save(100, '2:4', 100, 'Edited')
            self.assertTrue(result['last_save']['verified'])
            session.controller.save_current.assert_awaited_once_with('Edited', 100)

    async def test_backup_failure_prevents_hardware_save(self):
        with tempfile.TemporaryDirectory() as directory:
            session = self.session(directory)
            session.backup = Mock(side_effect=OSError('disk full'))
            with self.assertRaises(OSError):
                await session.save(100, '2:4', 100, 'Edited')
            session.controller.save_current.assert_not_awaited()

    async def test_physical_selection_change_during_backup_prevents_save(self):
        with tempfile.TemporaryDirectory() as directory:
            session = self.session(directory)
            controller = session.controller

            async def read(slot):
                controller.slot = 17
                return preset_fixture()

            controller.read_preset = AsyncMock(side_effect=read)
            with self.assertRaises(EditorConflict):
                await session.save(100, '2:4', 100, 'Edited')
            controller.save_current.assert_not_awaited()

    async def test_old_connection_revision_cannot_edit_reconnected_device(self):
        with tempfile.TemporaryDirectory() as directory:
            session = self.session(directory)
            with self.assertRaises(EditorConflict):
                await session.edit(100, '1:4', 'amp', 'gain', 0.6)
            session.controller.set_parameter.assert_not_awaited()

    async def test_old_preset_cannot_receive_edit(self):
        with tempfile.TemporaryDirectory() as directory:
            session = self.session(directory)
            with self.assertRaises(EditorConflict):
                await session.edit(17, '2:4', 'amp', 'gain', 0.6)
            session.controller.set_parameter.assert_not_awaited()

    async def test_model_must_be_on_micro_plus_list(self):
        with tempfile.TemporaryDirectory() as directory:
            session = self.session(directory)
            with self.assertRaises(ValueError):
                await session.replace(100, '2:4', 'amp', 'unknown-model')
            session.controller.replace_node.assert_not_awaited()

    async def test_invalid_save_target_never_reads_or_writes_device(self):
        with tempfile.TemporaryDirectory() as directory:
            for target in (0, 101, True, '100'):
                session = self.session(directory)
                with self.assertRaises(ValueError):
                    await session.save(100, '2:4', target, 'Edited')
                session.controller.read_preset.assert_not_awaited()
                session.controller.save_current.assert_not_awaited()

    async def test_http_stale_editor_is_conflict(self):
        with tempfile.TemporaryDirectory() as directory:
            session = self.session(directory)
            body = json.dumps({'action': 'parameter', 'preset': 100, 'revision': 'old',
                               'node': 'amp', 'parameter': 'gain', 'value': 0.6}).encode()
            with self.assertRaises(HTTPError) as caught:
                await dispatch('POST', '/api/micro-plus/editor',
                    {'host': 'localhost:8080', 'origin': 'http://localhost:8080',
                     'content-type': 'application/json'}, body, session)
            self.assertEqual(caught.exception.status, 409)

    async def test_save_response_must_be_verified_by_readback(self):
        controller = Controller(types.SimpleNamespace(is_connected=True), None)
        controller.slot = 100
        controller.document = preset_fixture()
        expected = copy.deepcopy(controller.document)
        expected['info']['displayName'] = 'Edited'

        async def acknowledge(*args):
            controller.saved = {'preset': 100, 'name': 'Edited'}
            controller.save_revision += 1

        controller.command = AsyncMock(side_effect=acknowledge)
        controller.read_preset = AsyncMock(return_value=preset_fixture())  # Different name.
        controller.refresh_current = AsyncMock()
        with self.assertRaises(RuntimeError):
            await controller.save_current('Edited', 100)
        controller.refresh_current.assert_not_awaited()
        self.assertFalse(presets_match(expected, preset_fixture()))

    async def test_float32_rounding_is_allowed_in_readback(self):
        expected = preset_fixture()
        actual = copy.deepcopy(expected)
        expected['audioGraph']['nodes'][0]['dspUnitParameters']['gain'] = .6
        actual['audioGraph']['nodes'][0]['dspUnitParameters']['gain'] = .6000000238418579
        self.assertTrue(presets_match(expected, actual))


class CopyAndTypeTests(unittest.IsolatedAsyncioTestCase):
    async def test_save_as_assigns_new_identity_without_mutating_source(self):
        controller = Controller(types.SimpleNamespace(is_connected=True), None)
        controller.slot = 17
        controller.document = preset_fixture()
        controller.document['info'].update(preset_id='SOURCE-ID', is_factory_default=True)
        original = copy.deepcopy(controller.document)
        controller.restore_preset = AsyncMock(return_value=preset_fixture())
        controller.refresh_current = AsyncMock()
        await controller.save_current('Copy', 100)
        copied, target = controller.restore_preset.call_args.args
        self.assertEqual(target, 100)
        self.assertNotEqual(copied['info']['preset_id'], 'SOURCE-ID')
        self.assertFalse(copied['info']['is_factory_default'])
        self.assertEqual(controller.document, original)

    async def test_integer_wire_type_is_read_before_editing(self):
        from mmp_ble import fields
        controller = Controller(types.SimpleNamespace(is_connected=True), None)
        controller.slot = controller.document_slot = 100
        controller.document = preset_fixture()
        controller.document['audioGraph']['nodes'][0]['dspUnitParameters']['comppreset'] = 1
        sent = []

        async def command(kind, payload):
            sent.append((kind, payload))
            if kind == 11:
                controller.parameters[('amp', 'comppreset')] = 1
                controller.parameter_types[('amp', 'comppreset')] = 5
            else:
                self.assertEqual(dict(fields(payload))[5], 0)
                controller.parameters[('amp', 'comppreset')] = 0
            controller.parameter_revision += 1

        controller.command = command
        controller.refresh_current = AsyncMock()
        await controller.set_parameter('amp', 'comppreset', 0)
        self.assertEqual([kind for kind, _ in sent], [11, 20])


if __name__ == '__main__':
    unittest.main()

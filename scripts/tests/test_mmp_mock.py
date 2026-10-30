"""The simulated amp must keep the same HTTP contract as the real session."""
import json
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mmp_mock import MockSession, mock_dispatch
from mmp_session import MicroPlusSession
from mmp_web import HTTPError

HEADERS = {'host': 'localhost:8092', 'origin': 'http://localhost:8092', 'content-type': 'application/json'}


class MockTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.session = MockSession(delay=0)

    async def post(self, path, body):
        code, _, data = await mock_dispatch('POST', path, HEADERS, json.dumps(body).encode(), self.session)
        return code, json.loads(data)

    def test_snapshot_has_the_same_fields_as_the_real_session(self):
        self.assertEqual(set(self.session.snapshot()), set(MicroPlusSession().snapshot()))

    async def test_edit_save_and_undo_round_trip(self):
        state = self.session.snapshot()
        _, state = await self.post('/api/micro-plus/editor', {
            'action': 'parameter', 'preset': state['preset'], 'revision': state['revision'],
            'node': 'amp', 'parameter': 'gain', 'value': 0.7})
        self.assertTrue(state['dirty'])
        _, state = await self.post('/api/micro-plus/editor', {
            'action': 'save', 'preset': state['preset'], 'revision': state['revision'], 'target': 3, 'name': 'Copy'})
        self.assertEqual(state['presets'][2]['name'], 'Copy')
        _, state = await self.post('/api/micro-plus/editor', {
            'action': 'undo-save', 'preset': state['preset'], 'revision': state['revision']})
        self.assertEqual(state['presets'][2]['name'], FIXTURE_NAME_3)
        self.assertIsNone(state['last_save'])

    async def test_limited_value_is_stored_and_reported(self):
        self.session.limits[('amp', 'gain')] = 0.3
        state = self.session.snapshot()
        _, state = await self.post('/api/micro-plus/editor', {
            'action': 'parameter', 'preset': state['preset'], 'revision': state['revision'],
            'node': 'amp', 'parameter': 'gain', 'value': 0.7})
        self.assertEqual(state['limited']['stored'], 0.3)
        self.assertTrue(state['connected'])
        amp = next(node for node in state['document']['audioGraph']['nodes'] if node['nodeId'] == 'amp')
        self.assertEqual(amp['dspUnitParameters']['gain'], 0.3)

    async def test_knob_change_makes_open_editor_stale(self):
        state = self.session.snapshot()
        await mock_dispatch('GET', '/__mock/knob/5', HEADERS, b'', self.session)
        with self.assertRaises(HTTPError) as caught:
            await self.post('/api/micro-plus/editor', {
                'action': 'parameter', 'preset': state['preset'], 'revision': state['revision'],
                'node': 'amp', 'parameter': 'gain', 'value': 0.7})
        self.assertEqual(caught.exception.status, 409)

    async def test_disconnect_clears_state_and_reconnect_changes_identity(self):
        before = self.session.snapshot()['revision']
        await mock_dispatch('GET', '/__mock/mode/disconnected', HEADERS, b'', self.session)
        self.assertEqual(self.session.snapshot()['presets'], [])
        await mock_dispatch('GET', '/__mock/mode/ok', HEADERS, b'', self.session)
        self.assertNotEqual(self.session.snapshot()['revision'], before)


FIXTURE_NAME_3 = 'Swirling Echoes'

if __name__ == '__main__':
    unittest.main()

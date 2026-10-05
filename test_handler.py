import base64
import unittest
from handler import decode_input, MAX_BYTES


class InputTests(unittest.TestCase):
    def test_default_thai(self):
        self.assertEqual(decode_input({"audio_base64": base64.b64encode(b"audio").decode()}), (b"audio", "th"))

    def test_invalid_input(self):
        for data in [None, [], {}, {"audio_base64": ""}, {"audio_base64": "!@#$"},
                     {"audio_base64": "data:audio/wav;base64,YQ=="},
                     {"audio_base64": "YQ==", "language": "unknown"},
                     {"audio_base64": "A" * (((MAX_BYTES + 2) // 3) * 4 + 4)}]:
            with self.subTest(data_type=type(data)):
                with self.assertRaises(ValueError):
                    decode_input(data)


if __name__ == "__main__":
    unittest.main()

import unittest

from cardkb import (
    BACKSPACE,
    CARDKB_ADDRESS,
    FN_LEFT,
    LEFT,
    MOD_FN,
    MOD_NONE,
    MOD_SYM,
    RETURN,
    CardKB,
)


class FakeI2C:
    def __init__(self, values):
        self.values = list(values)
        self.locked = False
        self.unlock_count = 0

    def try_lock(self):
        if self.locked:
            return False
        self.locked = True
        return True

    def unlock(self):
        self.locked = False
        self.unlock_count += 1

    def readfrom_into(self, address, buffer):
        if address != CARDKB_ADDRESS:
            raise AssertionError("unexpected I2C address")
        buffer[0] = self.values.pop(0)


class CardKBTests(unittest.TestCase):
    def test_reads_raw_key_and_releases_i2c_lock(self):
        i2c = FakeI2C([ord("a")])
        keyboard = CardKB(i2c)

        self.assertEqual(keyboard.get_raw(), ord("a"))
        self.assertFalse(i2c.locked)
        self.assertEqual(i2c.unlock_count, 1)

    def test_read_char_filters_keycodes_and_controls(self):
        keyboard = CardKB(FakeI2C([LEFT, ord("a"), RETURN, BACKSPACE]))

        self.assertEqual(keyboard.read_char(wait=False), None)
        self.assertEqual(keyboard.read_char(wait=False), "a")
        self.assertEqual(keyboard.read_char(wait=False), "\r")
        self.assertEqual(keyboard.read_char(wait=False), "\b")

    def test_read_key_decodes_arrows_and_modifiers(self):
        keyboard = CardKB(FakeI2C([FN_LEFT, ord("!"), 0]))

        self.assertEqual(keyboard.read_key(), (LEFT, None, MOD_FN))
        self.assertEqual(keyboard.read_key(), (ord("!"), "!", MOD_SYM))
        self.assertEqual(keyboard.read_key(), (None, None, None))
        self.assertEqual(CardKB.decode_arrow(LEFT), (LEFT, MOD_NONE))

    def test_releases_i2c_lock_when_read_fails(self):
        class FailingI2C(FakeI2C):
            def readfrom_into(self, address, buffer):
                raise OSError("I2C read failed")

        i2c = FailingI2C([])
        with self.assertRaises(OSError):
            CardKB(i2c).get_raw()
        self.assertFalse(i2c.locked)
        self.assertEqual(i2c.unlock_count, 1)


if __name__ == "__main__":
    unittest.main()

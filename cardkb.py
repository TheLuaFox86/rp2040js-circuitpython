"""CircuitPython driver for the M5Stack CardKB I2C keyboard.

The interface follows the CardKB's one-byte key reports and the public API of
the MicroPython driver: https://github.com/mchobby/esp8266-upy/tree/master/cardkb
"""

import time


CARDKB_ADDRESS = 0x5F

ESC = 0x1B
BACKSPACE = 0x08
DELETE = 0x7F
DEL = DELETE
TAB = 0x09
CR = 0x0D
RETURN = CR
LF = 0x10

LEFT = 0xB4
UP = 0xB5
DOWN = 0xB6
RIGHT = 0xB7

FN_LEFT = 0x98
FN_UP = 0x99
FN_DOWN = 0xA4
FN_RIGHT = 0xA5

MOD_NONE = 0x00
MOD_FN = 0x01
MOD_SYM = 0x02

_ASCII_SYMBOLS = frozenset(
    (33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 45, 47, 58, 59, 61,
     63, 64, 91, 92, 93, 94, 95, 96, 123, 124, 125, 126)
)
_ASCII_CONTROLS = frozenset((ESC, BACKSPACE, DELETE, TAB, CR, LF))
_ARROW_KEYS = frozenset((UP, DOWN, LEFT, RIGHT, FN_UP, FN_DOWN, FN_LEFT, FN_RIGHT))
_FN_ARROWS = {
    FN_UP: UP,
    FN_DOWN: DOWN,
    FN_LEFT: LEFT,
    FN_RIGHT: RIGHT,
}


class CardKB:
    """Read key reports from a CardKB using a CircuitPython ``busio.I2C`` bus."""

    def __init__(self, i2c, address=CARDKB_ADDRESS):
        if not isinstance(address, int) or not 0 <= address <= 0x7F:
            raise ValueError("I2C address must be a 7-bit integer")
        self.i2c = i2c
        self.address = address
        self._buffer = bytearray(1)

    def get_raw(self):
        """Return the next raw keycode, or zero when no key is available."""
        while not self.i2c.try_lock():
            pass
        try:
            self.i2c.readfrom_into(self.address, self._buffer)
            return self._buffer[0]
        finally:
            self.i2c.unlock()

    @staticmethod
    def is_ascii(data):
        """Return whether a CardKB keycode is a printable or supported control character."""
        return 0x20 <= data <= 0x7E or data in _ASCII_CONTROLS

    def is_ctrl(self, data):
        """Return whether a keycode is a control or arrow key."""
        return 0 <= data <= 0x1F or data == DELETE or self.is_arrow(data)

    @staticmethod
    def is_sym(data):
        """Return whether a keycode represents a symbol-key character."""
        return data in _ASCII_SYMBOLS

    @staticmethod
    def is_fn(data):
        """Return whether a keycode represents a function key."""
        return 0x80 <= data <= 0xAF and data != 0x97

    @staticmethod
    def is_arrow(data):
        """Return whether a keycode represents an arrow key."""
        return data in _ARROW_KEYS

    @staticmethod
    def decode_arrow(data):
        """Return an arrow keycode and its modifier."""
        if data in _FN_ARROWS:
            return _FN_ARROWS[data], MOD_FN
        if data in (UP, DOWN, LEFT, RIGHT):
            return data, MOD_NONE
        raise ValueError("keycode is not an arrow key")

    @staticmethod
    def keycode_to_arrow(data):
        arrows = {
            0xB4: "LEFT", 0xB5: "UP", 0xB6: "DOWN", 0xB7: "RIGHT",
            0x98: "LEFT", 0x99: "UP", 0xA4: "DOWN", 0xA5: "RIGHT",
        }
        return arrows.get(data, "")

    def read_char(self, wait=True):
        """Return the next supported ASCII character, or ``None`` if none is ready.

        When ``wait`` is true, poll until an ASCII key is available.
        """
        while True:
            keycode = self.get_raw()
            if self.is_ascii(keycode):
                return chr(keycode)
            if not wait:
                return None
            time.sleep(0.01)

    def read_key(self):
        """Return ``(keycode, character, modifier)`` or ``(None, None, None)``."""
        keycode = self.get_raw()
        if keycode == 0:
            return None, None, None

        if self.is_arrow(keycode):
            keycode, modifier = self.decode_arrow(keycode)
            return keycode, None, modifier

        character = chr(keycode) if self.is_ascii(keycode) else None
        if self.is_sym(keycode):
            modifier = MOD_SYM
        elif self.is_fn(keycode):
            modifier = MOD_FN
        else:
            modifier = MOD_NONE
        return keycode, character, modifier

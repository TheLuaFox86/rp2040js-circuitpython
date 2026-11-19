import board
import busio
import displayio
import time
import random
from adafruit_st7789 import ST7789
#from afafruit_bitmap_font import bitmap_font
from adafruit_display_text import label
import terminalio


displayio.release_displays()

# 1. Maximize SPI speed (RP2040 supports up to 62.5 MHz on SPI0)
spi = busio.SPI(clock=board.GP18, MOSI=board.GP19)
while not spi.try_lock():
    pass
spi.configure(baudrate=62500000)
spi.unlock()

# Match the ST7789 pins configured by the simulator in src/index.js.
tft_cs = board.GP13
tft_dc = board.GP14
tft_rst = board.GP15

display_bus = displayio.FourWire(
    spi, command=tft_dc, chip_select=tft_cs, reset=tft_rst
)

# 2. Initialize ST7789 with auto_refresh=False for manual frame control
display = ST7789(
    display_bus,
    width=240,
    height=240,
    rowstart=0,
    auto_refresh=False,
)

# 3. Set up your emulator's framebuffer bitmap
# Use the lowest color depth needed (e.g., 4 colors = 2-bit, 16 colors = 4-bit) to save RAM
fb_bitmap = displayio.Bitmap(240, 240, 16)
fb_palette = displayio.Palette(16)
fb_palette[0] = 0x0000FF  # Bright blue test color

main_group = displayio.Group()
main_group.append(displayio.TileGrid(fb_bitmap, pixel_shader=fb_palette))

# Set text, font, and color
text = "HELLO WORLD"
font = terminalio.FONT
color = 0xFF00FF

# Create the tet label
text_area = label.Label(font, text=text, color=color)

# Set the location
text_area.x = 20
text_area.y = 20
main_group.append(text_area)
# Call display.refresh() manually at the end of each emulated frame
display.show(main_group)
display.refresh()

while True:
    text_area.x = random.randint(20, 240)
    text_area.y = random.randint(20, 240)
    time.sleep(2)
    display.refresh()

import busio
import digitalio
import microcontroller as mc

buses = [
    ("SPI2", mc.pin.PB13, mc.pin.PB15, mc.pin.PB14),
    ("SPI1", mc.pin.PA5, mc.pin.PA7, mc.pin.PA6),
]
cs_candidates = ["PB12", "PC13", "PA4", "PB0", "PB1", "PC4", "PC5", "PA15"]

for bus_name, sck, mosi, miso in buses:
    try:
        spi = busio.SPI(sck, MOSI=mosi, MISO=miso)
    except Exception as e:
        print(bus_name, "unavailable:", e)
        continue
    while not spi.try_lock():
        pass
    try:
        spi.configure(baudrate=1000000, phase=0, polarity=0)
        for name in cs_candidates:
            pin = getattr(mc.pin, name, None)
            if pin is None:
                continue
            try:
                cs = digitalio.DigitalInOut(pin)
                cs.direction = digitalio.Direction.OUTPUT
                cs.value = True
                buf = bytearray(4)
                cs.value = False
                spi.write_readinto(bytes([0x9F, 0, 0, 0]), buf)
                cs.value = True
                cs.deinit()
                print(bus_name, "CS=" + name, "-> JEDEC:", [hex(b) for b in buf[1:]])
            except Exception as e:
                print(bus_name, "CS=" + name, "err:", e)
    finally:
        spi.unlock()
        spi.deinit()

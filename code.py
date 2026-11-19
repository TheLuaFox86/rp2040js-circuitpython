i2c = busio.I2C(board.GP5, board.GP4, frequency=100_000)
kb = cardkb.CardKB(i2c, address=0x5F)

while True:
    print(kb.read_char(True))
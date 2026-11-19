import time
time.sleep(0.5)
import os
import busio
import board
import cardkb

print("Wellcome!")
kb = cardkb.CardKB(i2c=busio.I2C(board.GP5, board.GP4), address=0x5F)
while True:
      key = kb.get_raw()
      if key:
          print(key, hex(key))
#    a = input(os.getcwd() + "> ")
#    args = a.split(" ")
#    if args[0] == "ls":
#        for i in os.listdir("./"):
#            print(i)

#    elif args[0] == "cd":
#        os.chdir(args[1])

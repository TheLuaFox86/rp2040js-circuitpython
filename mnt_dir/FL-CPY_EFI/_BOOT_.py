global __BOOT
__BOOT["osName"] = "Example EFI"
title.text = __BOOT["osName"]
Status(fr=__BOOT["osName"], text="YAY!", stat=status)
display.refresh()

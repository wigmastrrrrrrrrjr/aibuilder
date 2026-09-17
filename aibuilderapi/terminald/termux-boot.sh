#!/data/data/com.termux/files/usr/bin/bash
# Termux:Boot — keep the AI terminal daemon + serveo tunnel alive across reboots.
#
# Install (from Termux, once):
#   mkdir -p ~/.termux/boot
#   cp <repo>/aibuilderapi/terminald/termux-boot.sh ~/.termux/boot/aibuilder-term.sh
#   chmod +x ~/.termux/boot/aibuilder-term.sh
#
# Requires the Termux:Boot app (F-Droid). Logs: /root/.aibuilder/serveo.log
# (inside the Ubuntu proot). The key is /root/.ssh/id_ed25519 and the shared
# token is /root/.aibuilder/terminal-token, both created by terminald/serveo.sh.

export PATH=/data/data/com.termux/files/usr/bin:$PATH
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock

tmux kill-session -t aibuilder-term 2>/dev/null
tmux new-session -d -s aibuilder-term \
  "proot-distro login ubuntu -- bash -c 'SUBDOMAIN=aibuilder-term PORT=3000 bash /sdcard/Download/projects/aibuilder/aibuilderapi/terminald/serveo.sh'"

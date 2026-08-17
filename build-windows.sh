#!/usr/bin/env bash
#
# Cross-builds the Windows binaries into dist/.
#
# mydb has no cgo and no build step: the GUI is embedded with //go:embed and
# every dependency is pure Go, so this is a plain cross-compile and needs no
# toolchain beyond the one already installed.
#
#   ./build-windows.sh              both architectures
#   ./build-windows.sh amd64        just the one
#
set -euo pipefail

# go is not on the fish PATH on this machine, so find it where it lives.
GO="${GO:-$(command -v go || echo /usr/local/go/bin/go)}"
if [ ! -x "$GO" ]; then
	echo "build-windows: no go toolchain found (set GO=/path/to/go)" >&2
	exit 1
fi

cd "$(dirname "$0")"
OUT=dist
mkdir -p "$OUT"

ARCHES=("$@")
if [ ${#ARCHES[@]} -eq 0 ]; then
	ARCHES=(amd64 arm64)
fi

# Stamp the binary with the commit it was built from, so a copy that has been
# sitting on a server for a month can still say what it is.
REV="$($GO env GOVERSION)"
if git rev-parse --short HEAD >/dev/null 2>&1; then
	REV="$(git rev-parse --short HEAD)$(git diff --quiet || echo -dirty) $REV"
fi

for arch in "${ARCHES[@]}"; do
	exe="$OUT/mydb-windows-$arch.exe"
	echo "building $exe"
	# -trimpath keeps this machine's paths out of the binary; -s -w drop the
	# symbol and DWARF tables, which is most of the size.
	CGO_ENABLED=0 GOOS=windows GOARCH="$arch" \
		"$GO" build -trimpath -ldflags "-s -w -X 'main.buildRev=$REV'" -o "$exe" .
done

cp -f config.example.toml README.md "$OUT/"

if command -v zip >/dev/null 2>&1; then
	for arch in "${ARCHES[@]}"; do
		(cd "$OUT" && zip -q -FS "mydb-windows-$arch.zip" \
			"mydb-windows-$arch.exe" config.example.toml README.md)
		echo "packaged $OUT/mydb-windows-$arch.zip"
	done
fi

ls -lh "$OUT"/mydb-windows-*.exe

cat <<'EOF'

On the Windows box
------------------
  copy config.example.toml config.toml
  notepad config.toml
  mydb-windows-amd64.exe -v -c .\config.toml
  start http://localhost:9999

config.toml holds cleartext passwords. Windows has no chmod, and mydb's
0600 warning does not fire there, so lock it down yourself:

  icacls config.toml /inheritance:r /grant:r "%USERNAME%:F"

Known limitation: `agent = true` does not work on Windows. mydb reads
SSH_AUTH_SOCK and dials it as a unix socket; Windows OpenSSH publishes its
agent as the named pipe \\.\pipe\openssh-ssh-agent instead. Use `key` (with
`passphrase` if the key is encrypted) or `pass` in the [server.ssh] block
until that is supported.
EOF

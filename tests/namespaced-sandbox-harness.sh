#!/bin/sh
# Namespaced "sandbox" harness for pi-tmux-bridge.
#
# The user runs Pi through a wrapper that enters a container
# (`sbx exec -i -w "$PWD" pi-recovery-test -- pi …`). That container has its own
# /tmp, so a tmux session created on the host — and the host socket injected
# into the agent — cannot exist inside it. This script reproduces the same
# arrangement without containerd, using a persistent private mount namespace:
#
#   * a holder process keeps the namespace alive;
#   * the tmux socket directory (/tmp/tmux-$UID) is a private tmpfs inside it, so
#     the host tmux server is invisible and a tmux started inside is unreachable
#     from the host - the property that breaks sandboxed providers;
#   * the rest of /tmp stays shared, because Paseo passes host temp paths (the pi
#     extension) straight into the provider command line; a fully private /tmp
#     makes pi exit with "Extension path does not exist".
#   * `$ROOT/sbx` is the argv prefix the plugin is configured with, mirroring
#     the user's `sbx exec -i -w {cwd} <name> -- …`;
#   * `$ROOT/paseo-pi-namespaced` is the Paseo provider command, mirroring the
#     user's `~/.local/bin/paseo-pi-recovery`.
#
# The harness root deliberately lives outside /tmp so it is visible on both
# sides of the namespace. Entering a mount namespace requires CAP_SYS_ADMIN, so
# this harness enters with `sudo -n nsenter`; the plugin never learns that, it
# only ever runs the argv prefix it was configured with — exactly as with the
# real `sbx`.
#
# Usage:
#   tests/namespaced-sandbox-harness.sh start  [name]
#   tests/namespaced-sandbox-harness.sh status [name]
#   tests/namespaced-sandbox-harness.sh exec   [name] -- cmd args…
#   tests/namespaced-sandbox-harness.sh stop   [name]
set -eu

ROOT="${SBX_ROOT:-$HOME/sbx-test}"
NAME="${SBX_NAME:-pi-namespaced-test}"
if [ "${1:-}" = "start" ] || [ "${1:-}" = "status" ] || [ "${1:-}" = "stop" ]; then
  if [ "$#" -ge 2 ] && [ "${2#-}" = "$2" ]; then NAME="$2"; fi
fi
NS="$ROOT/$NAME.mntns"
HOLDER_PID="$ROOT/$NAME.pid"
mkdir -p "$ROOT"

enter() {
  # enter <name> <cwd> <cmd> [args…]
  name="$1"; cwd="$2"; shift 2
  ns="$ROOT/$name.mntns"
  [ -e "$ns" ] || { echo "sbx: unknown sandbox '$name'" >&2; exit 70; }
  # sudo replaces PATH with secure_path, so carry the caller's PATH explicitly.
  exec sudo -n -E nsenter --mount="$ns" -- \
    setpriv --reuid="$(id -u)" --regid="$(id -g)" --init-groups \
    env "PATH=$PATH" "HOME=${HOME:-/home/agent}" \
    sh -c 'cd "$1" || exit 70; shift; exec "$@"' sh "$cwd" "$@"
}

case "${1:-}" in
  start)
    if [ -f "$HOLDER_PID" ] && kill -0 "$(cat "$HOLDER_PID")" 2>/dev/null; then
      echo "already running: holder pid $(cat "$HOLDER_PID"), namespace $NS"
      exit 0
    fi
    rm -f "$NS" "$HOLDER_PID"
    : > "$NS"
    # /tmp is private inside the namespace, so the holder writes its own pid to
    # a path that exists on both sides.
    # tmux refuses a socket directory it does not own ("unsafe permissions"), so
    # the private tmpfs is owned by the calling user, like a real /tmp/tmux-$UID.
    uid="$(id -u)"; gid="$(id -g)"
    tmux_dir="/tmp/tmux-$uid"
    nohup sudo -n unshare -m sh -c \
      'mkdir -p "$1"; mount -t tmpfs -o uid="$2",gid="$3",mode=700 tmpfs "$1"; echo "$$" > "$4"; exec tail -f /dev/null' \
      sh "$tmux_dir" "$uid" "$gid" "$HOLDER_PID" >/dev/null 2>&1 &
    i=0
    while [ ! -s "$HOLDER_PID" ] && [ "$i" -lt 100 ]; do sleep 0.05; i=$((i + 1)); done
    [ -s "$HOLDER_PID" ] || { echo "harness: sandbox holder did not start" >&2; exit 1; }
    sudo -n mount --bind "/proc/$(cat "$HOLDER_PID")/ns/mnt" "$NS"

    # The argv prefix the plugin is configured with.
    cat > "$ROOT/sbx" <<SHIM
#!/bin/sh
# fake sbx: sbx exec -i -w <cwd> <name> -- cmd args…
name=""; cwd=""
while [ \$# -gt 0 ]; do
  case "\$1" in
    exec) shift ;;
    -i) shift ;;
    -w) cwd="\$2"; shift 2 ;;
    --) shift; break ;;
    -*) shift ;;
    *) if [ -z "\$name" ]; then name="\$1"; shift; continue; fi; break ;;
  esac
done
[ \$# -ge 1 ] || { echo "sbx: no command" >&2; exit 2; }
ns="${ROOT}/\$name.mntns"
[ -e "\$ns" ] || { echo "sbx: unknown sandbox '\$name'" >&2; exit 70; }
exec sudo -n -E nsenter --mount="\$ns" -- \\
  setpriv --reuid="\$(id -u)" --regid="\$(id -g)" --init-groups \\
  env "PATH=\$PATH" "HOME=\${HOME:-/home/agent}" \\
  sh -c 'cd "\$1" || exit 70; shift; exec "\$@"' sh "\${cwd:-\$PWD}" "\$@"
SHIM
    chmod +x "$ROOT/sbx"

    # The Paseo provider command, mirroring the user's paseo-pi-recovery wrapper.
    cat > "$ROOT/paseo-pi-namespaced" <<WRAP
#!/bin/sh
# Paseo provider command: enters the sandbox and execs pi, the way the user's
# ~/.local/bin/paseo-pi-recovery enters their container.
exec "$ROOT/sbx" exec -i -w "\$PWD" "$NAME" -- ${PI_BIN:-/usr/local/share/npm-global/bin/pi} "\$@"
WRAP
    chmod +x "$ROOT/paseo-pi-namespaced"

    echo "sandbox '$NAME': holder pid $(cat "$HOLDER_PID"), namespace file $NS"
    echo "prefix: [\"$ROOT/sbx\",\"exec\",\"-i\",\"-w\",\"{cwd}\",\"$NAME\",\"--\"]"
    echo "provider command: $ROOT/paseo-pi-namespaced"
    ;;

  status)
    if [ -f "$HOLDER_PID" ] && kill -0 "$(cat "$HOLDER_PID")" 2>/dev/null; then
      echo "holder pid $(cat "$HOLDER_PID") alive; namespace $NS"
    else
      echo "not running"
      exit 1
    fi
    ;;

  exec)
    name="$NAME"
    shift
    if [ "$#" -gt 0 ] && [ "$1" != "--" ] && [ "${1#-}" = "$1" ]; then name="$1"; shift; fi
    cwd="$PWD"
    while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
      if [ "$1" = "-w" ]; then cwd="$2"; shift 2; else shift; fi
    done
    [ "$#" -gt 1 ] || { echo "usage: $0 exec [name] [-w cwd] -- cmd args…" >&2; exit 2; }
    shift
    enter "$name" "$cwd" "$@"
    ;;

  stop)
    if [ -f "$HOLDER_PID" ]; then
      sudo -n kill "$(cat "$HOLDER_PID")" 2>/dev/null || true
      rm -f "$HOLDER_PID"
    fi
    sudo -n umount "$NS" 2>/dev/null || true
    rm -f "$NS" "$ROOT/sbx" "$ROOT/paseo-pi-namespaced"
    echo "sandbox '$NAME' stopped"
    ;;

  *)
    echo "usage: $0 start|status|exec|stop [name]" >&2
    exit 2
    ;;
esac

#!/usr/bin/env bash
# Source this in non-interactive agent shells before running Node/npm commands.
# It mirrors the Node-related parts of ~/.bashrc without loading prompt,
# aliases, completions, Conda, or other interactive shell setup.

if [ -f "$HOME/.local/bin/env" ]; then
  . "$HOME/.local/bin/env"
fi

FNM_PATH="${FNM_PATH:-$HOME/.local/share/fnm}"

if [ -d "$FNM_PATH" ]; then
  case ":$PATH:" in
    *:"$FNM_PATH":*) ;;
    *) export PATH="$FNM_PATH:$PATH" ;;
  esac
fi

if [ -x "$FNM_PATH/fnm" ]; then
  if [ -z "${XDG_RUNTIME_DIR:-}" ] || [ ! -w "$XDG_RUNTIME_DIR" ]; then
    export XDG_RUNTIME_DIR="${TMPDIR:-/tmp}"
  fi

  _fnm_env="$("$FNM_PATH/fnm" env --shell bash 2>/dev/null)" && eval "$_fnm_env"
  unset _fnm_env

  if command -v fnm >/dev/null 2>&1; then
    fnm use --silent-if-unchanged default >/dev/null 2>&1 || true
  fi
fi

if ! command -v node >/dev/null 2>&1 && [ -d "$FNM_PATH/aliases/default/bin" ]; then
  export PATH="$FNM_PATH/aliases/default/bin:$PATH"
fi

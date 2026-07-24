#!/usr/bin/env sh
# shellcheck disable=SC2034

pi_webui_docker_host_yaml_quote() {
  value=$1
  escaped=$(printf '%s' "$value" | sed "s/'/''/g")
  printf "'%s'" "$escaped"
}

pi_webui_docker_host_socket_path_from_endpoint() {
  endpoint=$1
  case "$endpoint" in
    unix://*) printf '%s\n' "${endpoint#unix://}" ;;
    *) return 1 ;;
  esac
}

pi_webui_docker_host_mac_desktop_socket_path() {
  [ -n "${HOME:-}" ] || return 1
  printf '%s/.docker/run/docker.sock\n' "$HOME"
}

pi_webui_docker_host_endpoint_is_linux_expected() {
  endpoint=$1
  [ "$endpoint" = unix:///var/run/docker.sock ]
}

pi_webui_docker_host_endpoint_is_mac_expected() {
  endpoint=$1
  if ! socket_path=$(pi_webui_docker_host_socket_path_from_endpoint "$endpoint" 2>/dev/null); then
    return 1
  fi

  case "$socket_path" in
    /var/run/docker.sock)
      return 0
      ;;
  esac

  if mac_socket_path=$(pi_webui_docker_host_mac_desktop_socket_path 2>/dev/null); then
    [ "$socket_path" = "$mac_socket_path" ] && return 0
  fi

  return 1
}

pi_webui_docker_host_socket_source_for_endpoint() {
  endpoint=$1
  pi_webui_docker_host_socket_path_from_endpoint "$endpoint"
}

pi_webui_docker_host_detect_docker_gid() {
  case "${PI_WEBUI_DETECTED_DOCKER_HOST_PROFILE:-}" in
    mac-docker-desktop)
      printf '0\n'
      return 0
      ;;
  esac

  socket_path=/var/run/docker.sock
  if [ -n "${PI_WEBUI_DETECTED_DOCKER_ENDPOINT:-}" ]; then
    if detected_socket_path=$(pi_webui_docker_host_socket_path_from_endpoint "$PI_WEBUI_DETECTED_DOCKER_ENDPOINT" 2>/dev/null); then
      socket_path=$detected_socket_path
    fi
  fi

  if [ -S "$socket_path" ]; then
    if gid=$(stat -c '%g' "$socket_path" 2>/dev/null); then
      printf '%s\n' "$gid"
      return 0
    fi
    if gid=$(stat -f '%g' "$socket_path" 2>/dev/null); then
      printf '%s\n' "$gid"
      return 0
    fi
  fi

  if [ -S /var/run/docker.sock ]; then
    if gid=$(stat -c '%g' /var/run/docker.sock 2>/dev/null); then
      printf '%s\n' "$gid"
      return 0
    fi
    if gid=$(stat -f '%g' /var/run/docker.sock 2>/dev/null); then
      printf '%s\n' "$gid"
      return 0
    fi
  fi

  if command -v getent >/dev/null 2>&1; then
    if gid=$(getent group docker | awk -F: 'NR == 1 { print $3 }'); then
      if [ -n "$gid" ]; then
        printf '%s\n' "$gid"
        return 0
      fi
    fi
  fi

  printf '0\n'
}

pi_webui_docker_host_detect_profile() {
  PI_WEBUI_DETECTED_HOST_OS=$(uname -s 2>/dev/null || printf 'unknown')
  PI_WEBUI_DETECTED_DOCKER_CONTEXT=
  PI_WEBUI_DETECTED_DOCKER_ENDPOINT=
  PI_WEBUI_DETECTED_DOCKER_HOST_ENV=${DOCKER_HOST:-}
  PI_WEBUI_DETECTED_DOCKER_EFFECTIVE_ENDPOINT=
  PI_WEBUI_DETECTED_DOCKER_SOCKET_SOURCE=
  PI_WEBUI_DETECTED_DOCKER_OS=
  PI_WEBUI_DETECTED_DOCKER_HOST_PROFILE=
  PI_WEBUI_DETECTED_HOSTEXEC_MODE=disabled
  PI_WEBUI_DOCKER_HOST_PROFILE_ERROR=

  if ! command -v docker >/dev/null 2>&1; then
    PI_WEBUI_DOCKER_HOST_PROFILE_ERROR="docker CLI is required"
    return 1
  fi

  PI_WEBUI_DETECTED_DOCKER_CONTEXT=$(docker context show 2>/dev/null || printf 'unknown')
  if [ -n "$PI_WEBUI_DETECTED_DOCKER_CONTEXT" ] && [ "$PI_WEBUI_DETECTED_DOCKER_CONTEXT" != unknown ]; then
    PI_WEBUI_DETECTED_DOCKER_ENDPOINT=$(docker context inspect "$PI_WEBUI_DETECTED_DOCKER_CONTEXT" --format '{{if .Endpoints.docker}}{{.Endpoints.docker.Host}}{{end}}' 2>/dev/null || printf '')
  fi

  case "$PI_WEBUI_DETECTED_HOST_OS" in
    Linux)
      if [ -n "$PI_WEBUI_DETECTED_DOCKER_HOST_ENV" ] && ! pi_webui_docker_host_endpoint_is_linux_expected "$PI_WEBUI_DETECTED_DOCKER_HOST_ENV"; then
        PI_WEBUI_DOCKER_HOST_PROFILE_ERROR="native Linux installs require DOCKER_HOST to be unset or exactly unix:///var/run/docker.sock, not $PI_WEBUI_DETECTED_DOCKER_HOST_ENV"
        return 1
      fi

      if [ -n "$PI_WEBUI_DETECTED_DOCKER_ENDPOINT" ] && ! pi_webui_docker_host_endpoint_is_linux_expected "$PI_WEBUI_DETECTED_DOCKER_ENDPOINT"; then
        PI_WEBUI_DOCKER_HOST_PROFILE_ERROR="native Linux installs require the local /var/run/docker.sock Docker context, not $PI_WEBUI_DETECTED_DOCKER_ENDPOINT"
        return 1
      fi

      PI_WEBUI_DETECTED_DOCKER_EFFECTIVE_ENDPOINT=${PI_WEBUI_DETECTED_DOCKER_HOST_ENV:-$PI_WEBUI_DETECTED_DOCKER_ENDPOINT}
      PI_WEBUI_DETECTED_DOCKER_SOCKET_SOURCE=/var/run/docker.sock
      if [ ! -S "$PI_WEBUI_DETECTED_DOCKER_SOCKET_SOURCE" ]; then
        PI_WEBUI_DOCKER_HOST_PROFILE_ERROR="native Linux installs require a local Docker socket at /var/run/docker.sock"
        return 1
      fi
      ;;
    Darwin)
      if [ -n "$PI_WEBUI_DETECTED_DOCKER_ENDPOINT" ] && ! pi_webui_docker_host_endpoint_is_mac_expected "$PI_WEBUI_DETECTED_DOCKER_ENDPOINT"; then
        PI_WEBUI_DOCKER_HOST_PROFILE_ERROR="macOS installs require a Docker Desktop local Unix socket context, not $PI_WEBUI_DETECTED_DOCKER_ENDPOINT"
        return 1
      fi

      if [ -n "$PI_WEBUI_DETECTED_DOCKER_HOST_ENV" ]; then
        if ! pi_webui_docker_host_endpoint_is_mac_expected "$PI_WEBUI_DETECTED_DOCKER_HOST_ENV"; then
          PI_WEBUI_DOCKER_HOST_PROFILE_ERROR="macOS installs require DOCKER_HOST to be unset or a Docker Desktop local Unix socket, not $PI_WEBUI_DETECTED_DOCKER_HOST_ENV"
          return 1
        fi
        PI_WEBUI_DETECTED_DOCKER_EFFECTIVE_ENDPOINT=$PI_WEBUI_DETECTED_DOCKER_HOST_ENV
      else
        PI_WEBUI_DETECTED_DOCKER_EFFECTIVE_ENDPOINT=$PI_WEBUI_DETECTED_DOCKER_ENDPOINT
      fi

      if [ -n "$PI_WEBUI_DETECTED_DOCKER_EFFECTIVE_ENDPOINT" ]; then
        if ! pi_webui_docker_host_endpoint_is_mac_expected "$PI_WEBUI_DETECTED_DOCKER_EFFECTIVE_ENDPOINT"; then
          PI_WEBUI_DOCKER_HOST_PROFILE_ERROR="macOS installs require a Docker Desktop local Unix socket, not ${PI_WEBUI_DETECTED_DOCKER_EFFECTIVE_ENDPOINT:-unknown}"
          return 1
        fi
        PI_WEBUI_DETECTED_DOCKER_SOCKET_SOURCE=$(pi_webui_docker_host_socket_source_for_endpoint "$PI_WEBUI_DETECTED_DOCKER_EFFECTIVE_ENDPOINT") || return 1
      elif mac_socket_path=$(pi_webui_docker_host_mac_desktop_socket_path 2>/dev/null) && [ -S "$mac_socket_path" ]; then
        PI_WEBUI_DETECTED_DOCKER_SOCKET_SOURCE=$mac_socket_path
      else
        PI_WEBUI_DETECTED_DOCKER_SOCKET_SOURCE=/var/run/docker.sock
      fi

      if [ ! -S "$PI_WEBUI_DETECTED_DOCKER_SOCKET_SOURCE" ]; then
        PI_WEBUI_DOCKER_HOST_PROFILE_ERROR="Docker Desktop socket is not accessible at $PI_WEBUI_DETECTED_DOCKER_SOCKET_SOURCE"
        return 1
      fi
      ;;
    *)
      PI_WEBUI_DOCKER_HOST_PROFILE_ERROR="unsupported host OS: $PI_WEBUI_DETECTED_HOST_OS"
      return 1
      ;;
  esac

  if ! docker info >/dev/null 2>&1; then
    PI_WEBUI_DOCKER_HOST_PROFILE_ERROR="docker daemon is not reachable by this user"
    return 1
  fi
  PI_WEBUI_DETECTED_DOCKER_OS=$(docker info --format '{{.OperatingSystem}}' 2>/dev/null || printf '')

  case "$PI_WEBUI_DETECTED_HOST_OS" in
    Linux)
      case "$PI_WEBUI_DETECTED_DOCKER_CONTEXT:$PI_WEBUI_DETECTED_DOCKER_OS" in
        *desktop-linux*|*"Docker Desktop"*)
          PI_WEBUI_DOCKER_HOST_PROFILE_ERROR="Docker Desktop on Linux is not supported by this installer because it runs containers inside a VM instead of the native Linux host"
          return 1
          ;;
      esac

      PI_WEBUI_DETECTED_DOCKER_HOST_PROFILE=linux-native-docker
      PI_WEBUI_DETECTED_HOSTEXEC_MODE=nsenter
      ;;
    Darwin)
      case "$PI_WEBUI_DETECTED_DOCKER_CONTEXT:$PI_WEBUI_DETECTED_DOCKER_OS:$PI_WEBUI_DETECTED_DOCKER_EFFECTIVE_ENDPOINT" in
        *desktop-linux*|*"Docker Desktop"*|*"/.docker/run/docker.sock"*)
          PI_WEBUI_DETECTED_DOCKER_HOST_PROFILE=mac-docker-desktop
          PI_WEBUI_DETECTED_HOSTEXEC_MODE=disabled
          ;;
        *)
          PI_WEBUI_DOCKER_HOST_PROFILE_ERROR="macOS installs currently require Docker Desktop; detected context '$PI_WEBUI_DETECTED_DOCKER_CONTEXT' endpoint '${PI_WEBUI_DETECTED_DOCKER_EFFECTIVE_ENDPOINT:-unknown}'"
          return 1
          ;;
      esac
      ;;
  esac

  return 0
}

pi_webui_docker_host_write_volume() {
  source_path=$1
  target_path=$2
  read_only=${3:-false}

  {
    printf '  - type: bind\n'
    printf '    source: %s\n' "$(pi_webui_docker_host_yaml_quote "$source_path")"
    printf '    target: %s\n' "$(pi_webui_docker_host_yaml_quote "$target_path")"
    if [ "$read_only" = true ]; then
      printf '    read_only: true\n'
    fi
  } >>"$PI_WEBUI_DOCKER_HOST_OVERRIDE_TEMP"
}

pi_webui_docker_host_write_existing_volume() {
  source_path=$1
  target_path=$2
  read_only=${3:-false}

  if [ -e "$source_path" ]; then
    pi_webui_docker_host_write_volume "$source_path" "$target_path" "$read_only"
  fi
}

pi_webui_docker_host_write_extra_volumes() {
  extra_paths=$1

  for extra_path in $extra_paths; do
    case "$extra_path" in
      /*) ;;
      *)
        printf '%s\n' "PI_WEBUI_DOCKER_EXTRA_HOST_PATHS entries must be absolute paths: $extra_path" >&2
        return 1
        ;;
    esac

    if [ ! -e "$extra_path" ]; then
      printf '%s\n' "PI_WEBUI_DOCKER_EXTRA_HOST_PATHS entry does not exist: $extra_path" >&2
      return 1
    fi

    pi_webui_docker_host_write_volume "$extra_path" "$extra_path" false
  done
}

pi_webui_docker_host_write_compose_override() {
  target_file=$1
  host_profile=$2
  extra_paths=${3:-}
  control_path=${4:-}
  target_dir=$(dirname "$target_file")
  mkdir -p "$target_dir" || return 1
  PI_WEBUI_DOCKER_HOST_OVERRIDE_TEMP=$target_file.$$

  case "$host_profile" in
    linux-native-docker) hostexec_mode=nsenter ;;
    mac-docker-desktop) hostexec_mode=disabled ;;
    *)
      printf '%s\n' "unsupported PI WEBUI Docker host profile: $host_profile" >&2
      return 1
      ;;
  esac

  cat >"$PI_WEBUI_DOCKER_HOST_OVERRIDE_TEMP" <<EOF
# Generated by PI WEBUI Docker host profile detection. Do not edit by hand.
# Re-run the installer or docker/pi-webui-docker --dev to refresh this file.

x-pi-webui-host-volumes: &pi-webui-host-volumes
EOF

  socket_source=${PI_WEBUI_DETECTED_DOCKER_SOCKET_SOURCE:-/var/run/docker.sock}
  pi_webui_docker_host_write_volume "$socket_source" /var/run/docker.sock false

  case "$host_profile" in
    linux-native-docker)
      pi_webui_docker_host_write_existing_volume /home /home false
      pi_webui_docker_host_write_existing_volume /srv /srv false
      pi_webui_docker_host_write_existing_volume /opt /opt false
      pi_webui_docker_host_write_volume / /host true
      ;;
    mac-docker-desktop)
      pi_webui_docker_host_write_existing_volume /Users /Users false
      pi_webui_docker_host_write_existing_volume /Volumes /Volumes false
      pi_webui_docker_host_write_existing_volume /private /private false
      ;;
  esac

  if ! pi_webui_docker_host_write_extra_volumes "$extra_paths"; then
    rm -f "$PI_WEBUI_DOCKER_HOST_OVERRIDE_TEMP"
    return 1
  fi

  if [ -n "$control_path" ]; then
    if [ ! -e "$control_path" ]; then
      printf '%s\n' "PI WEBUI Docker control path does not exist: $control_path" >&2
      rm -f "$PI_WEBUI_DOCKER_HOST_OVERRIDE_TEMP"
      return 1
    fi
    pi_webui_docker_host_write_volume "$control_path" "$control_path" false
  fi

  cat >>"$PI_WEBUI_DOCKER_HOST_OVERRIDE_TEMP" <<EOF

services:
  sessiond:
    environment:
      HOSTEXEC_MODE: $hostexec_mode
    volumes: *pi-webui-host-volumes

  web:
    environment:
      HOSTEXEC_MODE: $hostexec_mode
    volumes: *pi-webui-host-volumes
EOF

  mv "$PI_WEBUI_DOCKER_HOST_OVERRIDE_TEMP" "$target_file"
}

pi_webui_docker_host_print_detection_failure() {
  printf '%s\n' "PI WEBUI Docker setup could not determine a supported host profile." >&2
  printf '%s\n' "" >&2
  printf '%s\n' "Detected:" >&2
  printf '  host OS: %s\n' "${PI_WEBUI_DETECTED_HOST_OS:-unknown}" >&2
  printf '  docker context: %s\n' "${PI_WEBUI_DETECTED_DOCKER_CONTEXT:-unknown}" >&2
  printf '  docker endpoint: %s\n' "${PI_WEBUI_DETECTED_DOCKER_ENDPOINT:-unknown}" >&2
  printf '  DOCKER_HOST: %s\n' "${PI_WEBUI_DETECTED_DOCKER_HOST_ENV:-unset}" >&2
  printf '  effective endpoint: %s\n' "${PI_WEBUI_DETECTED_DOCKER_EFFECTIVE_ENDPOINT:-unknown}" >&2
  printf '  docker socket source: %s\n' "${PI_WEBUI_DETECTED_DOCKER_SOCKET_SOURCE:-unknown}" >&2
  printf '  docker OS: %s\n' "${PI_WEBUI_DETECTED_DOCKER_OS:-unknown}" >&2
  printf '%s\n' "" >&2
  printf '%s\n' "Supported profiles:" >&2
  printf '%s\n' "  - native Linux Docker Engine using /var/run/docker.sock" >&2
  printf '%s\n' "  - Docker Desktop for Mac" >&2
  if [ -n "${PI_WEBUI_DOCKER_HOST_PROFILE_ERROR:-}" ]; then
    printf '%s\n' "" >&2
    printf 'Reason: %s\n' "$PI_WEBUI_DOCKER_HOST_PROFILE_ERROR" >&2
  fi
}

pi_webui_docker_compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    printf '%s\n' "Docker Compose is required (docker compose plugin or docker-compose)" >&2
    return 1
  fi
}

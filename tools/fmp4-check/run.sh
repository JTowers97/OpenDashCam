#!/usr/bin/env bash
# Checks the app's fragmented-MP4 writer against real H.264/H.265/AAC streams, including simulated crashes.
# Needs Java 21+ and ffmpeg. Run from the repository root: tools/fmp4-check/run.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
src="$here/../../app/src/main/java/org/opendashcam/recording/FragmentedMp4Writer.java"
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT; cd "$work"
ffmpeg -y -v error -f lavfi -i testsrc=size=640x360:rate=30 -t 6 -c:v libx264 -bf 0 -g 30 -x264-params aud=1 -pix_fmt yuv420p -bsf:v h264_mp4toannexb -f h264 v.h264
ffmpeg -y -v error -f lavfi -i testsrc=size=640x360:rate=30 -t 6 -c:v libx265 -pix_fmt yuv420p -x265-params "aud=1:bframes=0:keyint=30:log-level=error" -f hevc v.hevc
ffmpeg -y -v error -f lavfi -i "sine=frequency=440:sample_rate=48000" -t 6 -ac 1 -c:a aac -b:a 128k -f adts a.aac
sed -e 's/^package .*;//' -e 's/^public final class FragmentedMp4Writer/final class FragmentedMp4Writer/' "$src" > Writer.part
(grep '^import ' Writer.part; cat "$here/MuxTest.part"; grep -v '^import ' Writer.part) > MuxTest.java
fail=0
check() { # file expected_frames
  local frames errors
  frames=$(ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -of csv=p=0 "$1")
  errors=$(ffmpeg -v error -i "$1" -f null - 2>&1 | wc -l)
  printf '%-14s video frames %-4s decode errors %s\n' "$1" "$frames" "$errors"
  [ "$frames" -ge "$2" ] && [ "$errors" -eq 0 ] || fail=1
}
java MuxTest.java h264 h264.mp4 >/dev/null && check h264.mp4 180
java MuxTest.java hevc hevc.mp4 >/dev/null && check hevc.mp4 180
java MuxTest.java h264 av.mp4 1.0 0 audio >/dev/null && check av.mp4 180
java MuxTest.java hevc crash.mp4 0.55 0 audio >/dev/null && check crash.mp4 95
[ $fail -eq 0 ] && echo "fragmented MP4 writer: OK" || { echo "fragmented MP4 writer: FAILED"; exit 1; }

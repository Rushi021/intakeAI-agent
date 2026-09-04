#!/bin/zsh
# Run the lane matrix in batches, so sixteen browsers never contend for one
# machine — contention shows up as settle() timeouts and reads as an agent bug.
# Usage: bench/matrix.sh <batch-size> <reps> [lane ...]
cd "$(dirname "$0")/.." || exit 1
SIZE=${1:-4}; REPS=${2:-1}; shift 2 2>/dev/null
LANES=("$@")
if [ ${#LANES[@]} -eq 0 ]; then
  LANES=(mockA-smoke mockA-struct mockA-awkward veridian-smoke veridian-struct veridian-awkward \
         trialforge-smoke trialforge-struct trialforge-awkward sourceone-smoke sourceone-struct sourceone-awkward)
fi
mkdir -p bench/out/matrix
for REP in $(seq 1 $REPS); do
  i=1
  while [ $i -le ${#LANES[@]} ]; do
    BATCH=(${LANES[@]:$((i-1)):$SIZE})
    echo "== rep $REP batch: $BATCH"
    node bench/all.mjs $BATCH > bench/out/matrix/batch-r$REP-$i.stdout 2>&1
    for L in $BATCH; do
      cp bench/out/$L.json bench/out/matrix/$L-r$REP.json 2>/dev/null
      cp bench/out/$L.log  bench/out/matrix/$L-r$REP.log  2>/dev/null
    done
    i=$((i+SIZE))
  done
done
echo "MATRIX DONE"

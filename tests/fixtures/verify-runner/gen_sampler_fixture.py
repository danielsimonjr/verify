"""Regenerate sampler.json from CPython's own random module.

    python gen_sampler_fixture.py > sampler.json

The runner's task sampling must pick exactly the tasks that
random.Random(seed).sample would. The tests compare against this file and need no
Python at run time; run this script only to refresh the expected values. The numbers
come from whatever interpreter runs it, so use CPython 3.12 or later (the sample and
seeding algorithms are the same there).
"""

import json
import math
import random
import sys

# Raw generator output, including seeds wider than 32 and 64 bits (multi-word init_by_array
# keys), zero, and a negative seed (CPython seeds from abs(seed)).
MT_SEEDS = [0, 1, 42, 2**32 - 1, 2**32, 2**32 + 5, 2**53 - 1, 2**64 + 123456789, -17]

# (seed, n, k) for random.Random(seed).sample(range(n), k). setsize is 21 for k <= 5 and
# 21 + 4**ceil(log4(3k)) for k > 5; n <= setsize takes the pool branch, otherwise the set
# branch. The cases sit on both sides of that boundary.
SAMPLE_CASES = [
    (0, 10, 3),  # pool, k <= 5
    (42, 21, 5),  # pool, n == setsize
    (42, 22, 5),  # set, n == setsize + 1
    (7, 100, 5),  # set, k <= 5
    (123, 50, 10),  # pool, k > 5 (setsize 85)
    (99, 85, 6),  # pool, n == setsize
    (99, 86, 6),  # set, n == setsize + 1
    (2024, 500, 20),  # set, k > 5
    (1, 1, 1),  # one item: _randbelow(1) still draws a bit
    (5, 7, 7),  # whole population, pool branch
    (5, 300, 0),  # nothing selected
    (2**32 + 5, 300, 12),  # two-word seed
    (-17, 40, 8),  # negative seed
    (31337, 1000, 120),  # pool: setsize is 21 + 4**5 = 1045
    (31337, 3000, 120),  # set, large k
    (31337, 5000, 500),  # set with frequent reselection (setsize is 21 + 4**6 = 4117)
    (2**64 + 123456789, 64, 40),  # three-word seed, k close to n
]

RANDBELOW_CASES = [(11, 1), (11, 2), (11, 3), (11, 7), (11, 1000), (11, 2**31 + 1), (11, 2**32 - 1)]

FRACTION_NS = [1, 3, 5, 10, 25, 40, 50, 101]
FRACTIONS = [0.05, 0.1, 0.2, 0.25, 0.3, 0.35, 0.5, 0.75, 0.9]


def branch(n, k):
    setsize = 21
    if k > 5:
        setsize += 4 ** math.ceil(math.log(k * 3, 4))
    return "pool" if n <= setsize else "set"


def words32(seed):
    rng = random.Random(seed)
    return [rng.getrandbits(32) for _ in range(8)]


def randbelow(seed, n):
    rng = random.Random(seed)
    return [rng._randbelow(n) for _ in range(6)]


def main():
    out = {
        "generator": f"CPython {sys.version.split()[0]}: random.Random(seed)",
        # Seeds are strings: some exceed 2**53 and would lose digits as JSON numbers.
        "mt32": [
            {"seed": str(s), "first": words32(s)} for s in MT_SEEDS
        ],
        "randbelow": [
            {"seed": str(seed), "n": n, "draws": randbelow(seed, n)} for seed, n in RANDBELOW_CASES
        ],
        "sample": [
            {
                "seed": str(seed),
                "n": n,
                "k": k,
                "branch": branch(n, k),
                "expected": random.Random(seed).sample(range(n), k),
            }
            for seed, n, k in SAMPLE_CASES
        ],
        # max(1, round(n * fraction)): Python rounds half to even, JavaScript half up.
        "fraction_count": [
            {"n": n, "fraction": f, "count": max(1, round(n * f))}
            for n in FRACTION_NS
            for f in FRACTIONS
        ],
        # The whole selection the runner makes for task keys t00..t(n-1):
        # sorted(random.Random(seed).sample(sorted(keys), count)).
        "select": [
            {
                "n": n,
                "seed": seed,
                "sample": sample,
                "fraction": fraction,
                "keys": select(n, seed, sample, fraction),
            }
            for n, seed, sample, fraction in [
                (30, 7, 5, 0),
                (30, 0, 12, 0),
                (10, 3, 0, 0.25),
                (40, 9, 0, 0.35),
                (30, 2, 20, 0.5),
            ]
        ],
    }
    assert {c["branch"] for c in out["sample"]} == {"pool", "set"}, "cover both sample branches"
    json.dump(out, sys.stdout, indent=1)
    sys.stdout.write("\n")


def select(n, seed, sample, fraction):
    keys = sorted(f"t{i:02d}" for i in range(n))
    if sample and sample < len(keys):
        keys = sorted(random.Random(seed).sample(keys, sample))
    if 0 < fraction < 1:
        keys = sorted(random.Random(seed).sample(keys, max(1, round(len(keys) * fraction))))
    return keys


if __name__ == "__main__":
    main()
